import { connect, type Connection, type Transaction } from '@tursodatabase/serverless'
import type { Sql } from './sql.ts'

type Queryable = {
  exec(sql: string): Promise<unknown>
  get(sql: string, ...args: unknown[]): Promise<unknown>
  all(sql: string, ...args: unknown[]): Promise<unknown[]>
  run(sql: string, ...args: unknown[]): Promise<{ changes?: number | bigint }>
}

function normalize<T>(row: unknown): T | undefined {
  if (row == null) return undefined
  if (typeof row !== 'object') return row as T
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = typeof value === 'bigint' ? Number(value) : value
  }
  return out as T
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
  const url = process.env.TURSO_DATABASE_URL
  const authToken = process.env.TURSO_AUTH_TOKEN
  if (!url || !authToken) throw new Error('Нужны TURSO_DATABASE_URL и TURSO_AUTH_TOKEN.')
  const connection = connect({ url, authToken })
  return queryable(connection, connection, false)
}
