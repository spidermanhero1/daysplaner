import { connect, type Connection, type Transaction } from '@tursodatabase/serverless'
import type { Sql } from './sql.ts'

type Queryable = {
  exec(sql: string): Promise<unknown>
  get(sql: string, ...args: unknown[]): Promise<unknown>
  all(sql: string, ...args: unknown[]): Promise<unknown[]>
  run(sql: string, ...args: unknown[]): Promise<{ changes?: number | bigint }>
}

const nativeFetch = globalThis.fetch

function normalize<T>(row: unknown): T | undefined {
  if (row == null) return undefined
  if (typeof row !== 'object') return row as T
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value
  }
  return out as T
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim()
  }
  return value
}

function readCredentials(): { url: string; authToken: string } {
  const rawUrl = stripQuotes((process.env.TURSO_DATABASE_URL ?? '').trim())
  const authToken = stripQuotes((process.env.TURSO_AUTH_TOKEN ?? '').trim())
    .replace(/^Bearer\s+/i, '')
    .replace(/\s+/g, '')
  if (!rawUrl || !authToken) throw new Error('Нужны TURSO_DATABASE_URL и TURSO_AUTH_TOKEN.')
  let parsed: URL
  try {
    parsed = new URL(rawUrl.replace(/^(libsql|turso):\/\//i, 'https://'))
  } catch {
    throw new Error('TURSO_DATABASE_URL не похож на адрес базы.')
  }
  parsed.search = ''
  parsed.hash = ''
  return { url: parsed.toString().replace(/\/$/, ''), authToken }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function isPipeline(url: string): boolean {
  try {
    const path = new URL(url).pathname
    return path.endsWith('/v3/pipeline') || path.endsWith('/v3/cursor')
  } catch {
    return false
  }
}

function explainStatus(status: number, body: string): string {
  const text = body.replace(/\s+/g, ' ').trim().slice(0, 240)
  if (/jwt|could not parse|malformed token|invalid token/i.test(text)) {
    return 'Turso не принял TURSO_AUTH_TOKEN. Нужен токен этой базы, целиком, без кавычек и без Bearer.'
  }
  if (status === 401) return 'Turso не узнал TURSO_AUTH_TOKEN.'
  if (status === 404) return 'Turso не нашёл базу по TURSO_DATABASE_URL.'
  return text ? `База ответила ${status}: ${text}` : `База ответила ${status}.`
}

function nextPipelineUrl(location: string, current: string): string {
  const next = new URL(location, current)
  const path = next.pathname
  if (!path.endsWith('/v3/pipeline') && !path.endsWith('/v3/cursor')) {
    next.pathname = new URL(current).pathname
  }
  next.search = ''
  next.hash = ''
  return next.toString()
}

// fetch превращает POST в GET на 301 и 302. Turso на такой GET отвечает 400.
async function pipelineFetch(url: string, init?: RequestInit): Promise<Response> {
  let current = url
  for (let hop = 0; hop < 4; hop++) {
    const response = await nativeFetch(current, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('База перенаправила запрос без адреса.')
      current = nextPipelineUrl(location, current)
      continue
    }
    if (!response.ok) {
      const body = await response.text()
      throw new Error(explainStatus(response.status, body))
    }
    return response
  }
  throw new Error('Слишком много перенаправлений к базе.')
}

const tursoFetch: typeof fetch = (input, init) => {
  const url = requestUrl(input)
  if (!isPipeline(url)) return nativeFetch(input, init)
  return pipelineFetch(url, init)
}

function installTursoFetch() {
  if (globalThis.fetch === tursoFetch) return
  globalThis.fetch = tursoFetch
}

function queryable(runner: Queryable, connection: Connection, nested: boolean): Sql {
  return {
    exec: async (sql) => {
      await runner.exec(sql)
    },
    get: async (sql, args) => {
      const row = args === undefined ? await runner.get(sql) : await runner.get(sql, args)
      return normalize(row)
    },
    all: async (sql, args) => {
      const rows = args === undefined ? await runner.all(sql) : await runner.all(sql, args)
      return rows.map((row) => normalize(row) as never)
    },
    run: async (sql, args) => {
      const info = args === undefined ? await runner.run(sql) : await runner.run(sql, args)
      return { changes: Number(info?.changes ?? 0) }
    },
    transaction: (fn) => {
      if (nested) return Promise.reject(new Error('Вложенная транзакция.'))
      const txn = connection.transactionAsync(async (tx: Transaction) => fn(queryable(tx, connection, true)))
      return txn.concurrent()
    },
    close: async () => {
      if (!nested) await connection.close()
    },
  }
}

export function openTurso(): Sql {
  const { url, authToken } = readCredentials()
  installTursoFetch()
  const connection = connect({ url, authToken })
  return queryable(connection, connection, false)
}
