import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { createHash, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { addDays, resolveDay, spanDays, todayKey } from '../shared/dates.ts'
import type { Priority } from '../shared/types.ts'
import { openDatabase, parseTitle } from './db.ts'
import { InputError } from './errors.ts'

const COOKIE = 'plandays'
const password = process.env.PLANDAYS_PASSWORD ?? ''
const production = process.env.NODE_ENV === 'production'
const port = Number(process.env.PLANDAYS_PORT ?? 8787)
const certFile = process.env.PLANDAYS_TLS_CERT
const keyFile = process.env.PLANDAYS_TLS_KEY
const directTls = Boolean(certFile && keyFile)
const behindProxy = process.env.PLANDAYS_HTTPS === '1'
const dbFile = process.env.PLANDAYS_DB ?? 'data/plandays.sqlite'

if (production && !password) {
  console.error('В проде нужен PLANDAYS_PASSWORD.')
  process.exit(1)
}
if (production && !directTls && !behindProxy) {
  console.error(
    'В проде нужен HTTPS: PLANDAYS_TLS_CERT и PLANDAYS_TLS_KEY, либо PLANDAYS_HTTPS=1 за прокси (см. Caddyfile).',
  )
  process.exit(1)
}
if (directTls && behindProxy) {
  console.error('Выбери одно: свой сертификат или PLANDAYS_HTTPS=1 за прокси.')
  process.exit(1)
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PLANDAYS_PORT должен быть портом.')
  process.exit(1)
}

const db = openDatabase(dbFile)
const hostname =
  process.env.PLANDAYS_HOST ?? (production && behindProxy ? '127.0.0.1' : '0.0.0.0')

function passwordOk(input: string): boolean {
  const left = createHash('sha256').update(input).digest()
  const right = createHash('sha256').update(password).digest()
  return timingSafeEqual(left, right)
}

function requestIsHttps(c: Context): boolean {
  if (directTls) return true
  return behindProxy && c.req.header('x-forwarded-proto') === 'https'
}

function originOk(c: Context): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true
  const host = c.req.header('host')
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function dayPayload(day: string) {
  return { day, today: todayKey(), tasks: db.tasksForDay(day) }
}

const app = new Hono()

app.use('*', async (c, next) => {
  if (behindProxy && c.req.header('x-forwarded-proto') === 'http') {
    const host = c.req.header('host')
    if (host) {
      const url = new URL(c.req.url)
      url.protocol = 'https:'
      url.host = host
      return c.redirect(url.toString(), 301)
    }
  }
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  if (requestIsHttps(c)) c.header('Strict-Transport-Security', 'max-age=15552000')
})

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !originOk(c)) {
    return c.json({ error: 'Чужой источник.' }, 403)
  }
  const open = c.req.path === '/api/session' || (c.req.path === '/api/login' && c.req.method === 'POST')
  if (!password || open) {
    await next()
    return
  }
  const token = getCookie(c, COOKIE)
  if (!token || !db.sessionValid(token)) return c.json({ error: 'Нужен вход.' }, 401)
  await next()
})

app.get('/api/session', (c) => {
  if (!password) return c.json({ required: false, ok: true })
  const token = getCookie(c, COOKIE)
  return c.json({ required: true, ok: Boolean(token && db.sessionValid(token)) })
})

app.post('/api/login', async (c) => {
  if (!password) return c.json({ ok: true })
  const body = await c.req.json().catch(() => null)
  const input = body && typeof body.password === 'string' ? body.password : ''
  if (!input || input.length > 500 || !passwordOk(input)) {
    return c.json({ error: 'Не тот пароль.' }, 401)
  }
  const session = db.createSession()
  setCookie(c, COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: requestIsHttps(c),
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return c.json({ ok: true })
})

app.post('/api/logout', (c) => {
  const token = getCookie(c, COOKIE)
  if (token) db.deleteSession(token)
  deleteCookie(c, COOKIE, { path: '/' })
  return c.json({ ok: true })
})

app.get('/api/days/:day', (c) => {
  const day = resolveDay(c.req.param('day'))
  if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
  return c.json(dayPayload(day))
})

app.get('/api/span/:from/:to', (c) => {
  const from = c.req.param('from')
  const to = c.req.param('to')
  const count = spanDays(from, to)
  if (count === null) return c.json({ error: 'Нет такой даты.' }, 400)
  if (count > 42) return c.json({ error: 'Слишком длинный отрезок.' }, 400)
  return c.json({ from, to, today: todayKey(), tasks: db.tasksForSpan(from, to) })
})

app.post('/api/days/:day/tasks', async (c) => {
  const day = resolveDay(c.req.param('day'))
  if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
  const body = await c.req.json().catch(() => null)
  const title = parseTitle(body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined)
  db.addTask(day, title)
  return c.json(dayPayload(day), 201)
})

app.post('/api/days/:day/reorder', async (c) => {
  const day = resolveDay(c.req.param('day'))
  if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
  const body = await c.req.json().catch(() => null)
  const ids = body && typeof body === 'object' ? (body as { ids?: unknown }).ids : undefined
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return c.json({ error: 'Список уже изменился.' }, 409)
  }
  db.reorder(day, ids)
  return c.json(dayPayload(day))
})

app.post('/api/days/:day/carry', (c) => {
  const day = resolveDay(c.req.param('day'))
  if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
  const to = addDays(day, 1)
  const moved = db.carry(day, to)
  return c.json({ ...dayPayload(day), moved, to })
})

app.get('/api/archive', (c) => {
  return c.json({ today: todayKey(), groups: db.archive() })
})

app.post('/api/tasks/:id/subtasks', async (c) => {
  const body = await c.req.json().catch(() => null)
  const title = parseTitle(body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined)
  const updated = db.addSubtask(c.req.param('id'), title)
  if (!updated) return c.json({ error: 'Дела уже нет.' }, 404)
  return c.json({ day: updated.day, today: todayKey(), tasks: updated.tasks }, 201)
})

app.post('/api/tasks/:id/reorder', async (c) => {
  const body = await c.req.json().catch(() => null)
  const ids = body && typeof body === 'object' ? (body as { ids?: unknown }).ids : undefined
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return c.json({ error: 'Список уже изменился.' }, 409)
  }
  const updated = db.reorderSubtasks(c.req.param('id'), ids)
  if (!updated) return c.json({ error: 'Дела уже нет.' }, 404)
  return c.json({ day: updated.day, today: todayKey(), tasks: updated.tasks })
})

app.patch('/api/tasks/:id', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new InputError('Нечего менять.')
  const patch: { title?: string; priority?: Priority; done?: boolean } = {}
  const record = body as { title?: unknown; priority?: unknown; done?: unknown }
  if ('title' in record) patch.title = parseTitle(record.title)
  if ('priority' in record) {
    if (record.priority !== 'normal' && record.priority !== 'important') {
      throw new InputError('Приоритет только обычный или важный.')
    }
    patch.priority = record.priority
  }
  if ('done' in record) {
    if (typeof record.done !== 'boolean') throw new InputError('Нечего менять.')
    patch.done = record.done
  }
  if (Object.keys(patch).length === 0) throw new InputError('Нечего менять.')
  const updated = db.updateTask(c.req.param('id'), patch)
  if (!updated) return c.json({ error: 'Дела уже нет.' }, 404)
  return c.json({ day: updated.day, today: todayKey(), tasks: updated.tasks })
})

app.delete('/api/tasks/:id', (c) => {
  const removed = db.deleteTask(c.req.param('id'))
  if (!removed) return c.json({ error: 'Дела уже нет.' }, 404)
  return c.json({ day: removed.day, today: todayKey(), tasks: removed.tasks })
})

function smokePayload(day: string) {
  return { day, today: todayKey(), ...db.smokeFor(day) }
}

app.get('/api/smoke/:day', (c) => {
  const day = resolveDay(c.req.param('day'))
  if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
  return c.json(smokePayload(day))
})

app.patch('/api/smoke/:day', async (c) => {
  const day = resolveDay(c.req.param('day'))
  if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new InputError('Нечего менять.')
  const record = body as { packs?: unknown; open?: unknown; joints?: unknown }
  db.setSmokeStock({ packs: record.packs, open: record.open, joints: record.joints })
  return c.json(smokePayload(day))
})

app.post('/api/smoke/:day', async (c) => {
  const day = resolveDay(c.req.param('day'))
  if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
  const body = await c.req.json().catch(() => null)
  const kind = body && typeof body === 'object' ? (body as { kind?: unknown }).kind : undefined
  if (kind !== 'cig' && kind !== 'joint') throw new InputError('Нечего менять.')
  db.addSmokeBreak(day, kind)
  return c.json(smokePayload(day), 201)
})

app.delete('/api/smoke/:day/breaks/:id', (c) => {
  const day = resolveDay(c.req.param('day'))
  if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
  db.undoSmokeBreak(c.req.param('id'))
  return c.json(smokePayload(day))
})

app.all('/api/*', (c) => c.json({ error: 'Нет такого запроса.' }, 404))

if (production) {
  const dist = resolve('dist')
  if (!existsSync(resolve(dist, 'index.html'))) {
    console.error('Нет сборки. Сначала npm run build.')
    process.exit(1)
  }
  app.use('/*', serveStatic({ root: dist }))
  app.get('*', serveStatic({ path: resolve(dist, 'index.html') }))
}

app.onError((error, c) => {
  if (error instanceof InputError) {
    const status = error.status === 409 ? 409 : 400
    return c.json({ error: error.message }, status)
  }
  console.error(error)
  return c.json({ error: 'Не сохранилось.' }, 500)
})

const server = serve({
  fetch: app.fetch,
  port,
  hostname,
  ...(directTls
    ? {
        createServer,
        serverOptions: {
          cert: readFileSync(certFile!),
          key: readFileSync(keyFile!),
        },
      }
    : {}),
})

const scheme = directTls ? 'https' : 'http'
console.log(`Дни: ${scheme}://127.0.0.1:${port}`)
console.log(`База: ${resolve(dbFile)}`)
console.log(password ? 'Вход: один пароль' : 'Вход: выключен')
if (directTls) console.log('HTTPS: сертификат')
if (behindProxy) console.log('HTTPS: ждёт прокси, слушаю только localhost')

function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
