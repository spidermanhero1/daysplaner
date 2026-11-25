import { createHash, timingSafeEqual } from 'node:crypto'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { resolveDay, spanDays, todayKey } from '../shared/dates.ts'
import { isThemeId, type ThemeId } from '../shared/themes.ts'
import type { OrderStatus, Priority } from '../shared/types.ts'
import type { Runtime } from './boot.ts'
import type { AppDatabase } from './db.ts'
import { parseOrderStatus, parseProfileName, parseShop, parseTitle } from './db.ts'
import { InputError } from './errors.ts'

const COOKIE = 'plandays'
const WHO = 'plandays_profile'

export function createApp(db: AppDatabase, runtime: Runtime) {
  const { password } = runtime

  function passwordOk(input: string): boolean {
    const left = createHash('sha256').update(input).digest()
    const right = createHash('sha256').update(password).digest()
    return timingSafeEqual(left, right)
  }

  function requestIsHttps(c: Context): boolean {
    if (runtime.directTls || runtime.onVercel) return true
    return runtime.behindProxy && c.req.header('x-forwarded-proto') === 'https'
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

  function setWho(c: Context, id: string) {
    setCookie(c, WHO, id, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: requestIsHttps(c),
      path: '/',
      maxAge: 60 * 60 * 24 * 400,
    })
  }

  function who(c: Context): Promise<string> {
    return db.resolveProfile(getCookie(c, WHO))
  }

  async function profilesBody(c: Context, currentId?: string) {
    const id = currentId ?? (await who(c))
    if (getCookie(c, WHO) !== id) setWho(c, id)
    return { profiles: await db.listProfiles(), currentId: id }
  }

  async function dayPayload(profileId: string, day: string) {
    return { day, today: todayKey(), tasks: await db.tasksForDay(profileId, day) }
  }

  async function smokePayload(profileId: string, day: string) {
    return { day, today: todayKey(), ...(await db.smokeFor(profileId, day)) }
  }

  const app = new Hono()

  app.use('*', async (c, next) => {
    if (runtime.behindProxy && c.req.header('x-forwarded-proto') === 'http') {
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
    if (!token || !(await db.sessionValid(token))) return c.json({ error: 'Нужен вход.' }, 401)
    await next()
  })

  app.get('/api/session', async (c) => {
    if (!password) return c.json({ required: false, ok: true })
    const token = getCookie(c, COOKIE)
    return c.json({ required: true, ok: Boolean(token && (await db.sessionValid(token))) })
  })

  app.post('/api/login', async (c) => {
    if (!password) return c.json({ ok: true })
    const body = await c.req.json().catch(() => null)
    const input = body && typeof body.password === 'string' ? body.password : ''
    if (!input || input.length > 500 || !passwordOk(input)) {
      return c.json({ error: 'Не тот пароль.' }, 401)
    }
    const session = await db.createSession()
    setCookie(c, COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: requestIsHttps(c),
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
    return c.json({ ok: true })
  })

  app.post('/api/logout', async (c) => {
    const token = getCookie(c, COOKIE)
    if (token) await db.deleteSession(token)
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  app.get('/api/profiles', async (c) => c.json(await profilesBody(c)))

  app.post('/api/profiles', async (c) => {
    const body = await c.req.json().catch(() => null)
    const name = parseProfileName(body && typeof body === 'object' ? (body as { name?: unknown }).name : undefined)
    const id = await db.addProfile(name)
    return c.json(await profilesBody(c, id), 201)
  })

  app.patch('/api/profiles/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') throw new InputError('Нечего менять.')
    const record = body as { name?: unknown; theme?: unknown }
    const patch: { name?: string; theme?: ThemeId } = {}
    if ('name' in record) patch.name = parseProfileName(record.name)
    if ('theme' in record) {
      if (!isThemeId(record.theme)) throw new InputError('Нет такого вида.')
      patch.theme = record.theme
    }
    if (Object.keys(patch).length === 0) throw new InputError('Нечего менять.')
    const updated = await db.updateProfile(c.req.param('id'), patch)
    if (!updated) return c.json({ error: 'Профиля уже нет.' }, 404)
    return c.json(await profilesBody(c))
  })

  app.delete('/api/profiles/:id', async (c) => {
    const id = c.req.param('id')
    const removed = await db.deleteProfile(id)
    if (!removed) return c.json({ error: 'Профиля уже нет.' }, 404)
    return c.json(await profilesBody(c, await db.resolveProfile(getCookie(c, WHO))))
  })

  app.post('/api/profiles/:id/use', async (c) => {
    const id = c.req.param('id')
    if (!(await db.hasProfile(id))) return c.json({ error: 'Профиля уже нет.' }, 404)
    return c.json(await profilesBody(c, id))
  })

  app.get('/api/days/:day', async (c) => {
    const day = resolveDay(c.req.param('day'))
    if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
    return c.json(await dayPayload(await who(c), day))
  })

  app.get('/api/span/:from/:to', async (c) => {
    const from = c.req.param('from')
    const to = c.req.param('to')
    const count = spanDays(from, to)
    if (count === null) return c.json({ error: 'Нет такой даты.' }, 400)
    if (count > 42) return c.json({ error: 'Слишком длинный отрезок.' }, 400)
    const profileId = await who(c)
    return c.json({ from, to, today: todayKey(), tasks: await db.tasksForSpan(profileId, from, to) })
  })

  app.post('/api/days/:day/tasks', async (c) => {
    const day = resolveDay(c.req.param('day'))
    if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
    const body = await c.req.json().catch(() => null)
    const title = parseTitle(body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined)
    const profileId = await who(c)
    await db.addTask(profileId, day, title)
    return c.json(await dayPayload(profileId, day), 201)
  })

  app.post('/api/days/:day/reorder', async (c) => {
    const day = resolveDay(c.req.param('day'))
    if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
    const body = await c.req.json().catch(() => null)
    const ids = body && typeof body === 'object' ? (body as { ids?: unknown }).ids : undefined
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return c.json({ error: 'Список уже изменился.' }, 409)
    }
    const profileId = await who(c)
    await db.reorder(profileId, day, ids)
    return c.json(await dayPayload(profileId, day))
  })

  app.post('/api/days/:day/carry', async (c) => {
    const day = resolveDay(c.req.param('day'))
    if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
    const body = await c.req.json().catch(() => null)
    const raw = body && typeof body === 'object' ? (body as { to?: unknown }).to : undefined
    const to = typeof raw === 'string' ? resolveDay(raw) : null
    if (!to) return c.json({ error: 'Нет такой даты.' }, 400)
    if (to === day) return c.json({ error: 'Это тот же день.' }, 400)
    const profileId = await who(c)
    const moved = await db.carry(profileId, day, to)
    return c.json({ ...(await dayPayload(profileId, day)), moved, to })
  })

  app.get('/api/archive', async (c) => {
    return c.json({ today: todayKey(), groups: await db.archive(await who(c)) })
  })

  app.post('/api/tasks/:id/subtasks', async (c) => {
    const body = await c.req.json().catch(() => null)
    const title = parseTitle(body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined)
    const updated = await db.addSubtask(await who(c), c.req.param('id'), title)
    if (!updated) return c.json({ error: 'Дела уже нет.' }, 404)
    return c.json({ day: updated.day, today: todayKey(), tasks: updated.tasks }, 201)
  })

  app.post('/api/tasks/:id/reorder', async (c) => {
    const body = await c.req.json().catch(() => null)
    const ids = body && typeof body === 'object' ? (body as { ids?: unknown }).ids : undefined
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return c.json({ error: 'Список уже изменился.' }, 409)
    }
    const updated = await db.reorderSubtasks(await who(c), c.req.param('id'), ids)
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
    const updated = await db.updateTask(await who(c), c.req.param('id'), patch)
    if (!updated) return c.json({ error: 'Дела уже нет.' }, 404)
    return c.json({ day: updated.day, today: todayKey(), tasks: updated.tasks })
  })

  app.delete('/api/tasks/:id', async (c) => {
    const removed = await db.deleteTask(await who(c), c.req.param('id'))
    if (!removed) return c.json({ error: 'Дела уже нет.' }, 404)
    return c.json({ day: removed.day, today: todayKey(), tasks: removed.tasks })
  })

  app.get('/api/smoke/:day', async (c) => {
    const day = resolveDay(c.req.param('day'))
    if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
    return c.json(await smokePayload(await who(c), day))
  })

  app.patch('/api/smoke/:day', async (c) => {
    const day = resolveDay(c.req.param('day'))
    if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') throw new InputError('Нечего менять.')
    const record = body as { packs?: unknown; open?: unknown; joints?: unknown }
    const profileId = await who(c)
    await db.setSmokeStock(profileId, { packs: record.packs, open: record.open, joints: record.joints })
    return c.json(await smokePayload(profileId, day))
  })

  app.post('/api/smoke/:day', async (c) => {
    const day = resolveDay(c.req.param('day'))
    if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
    const body = await c.req.json().catch(() => null)
    const kind = body && typeof body === 'object' ? (body as { kind?: unknown }).kind : undefined
    if (kind !== 'cig' && kind !== 'joint') throw new InputError('Нечего менять.')
    const profileId = await who(c)
    await db.addSmokeBreak(profileId, day, kind)
    return c.json(await smokePayload(profileId, day), 201)
  })

  app.delete('/api/smoke/:day/breaks/:id', async (c) => {
    const day = resolveDay(c.req.param('day'))
    if (!day) return c.json({ error: 'Нет такой даты.' }, 400)
    const profileId = await who(c)
    await db.undoSmokeBreak(profileId, c.req.param('id'))
    return c.json(await smokePayload(profileId, day))
  })

  app.get('/api/shopping', async (c) => c.json(await db.shopping(await who(c))))

  app.post('/api/shopping/groceries', async (c) => {
    const body = await c.req.json().catch(() => null)
    const title = parseTitle(body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined)
    return c.json(await db.addGrocery(await who(c), title), 201)
  })

  app.patch('/api/shopping/groceries/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    const title = parseTitle(body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined)
    const updated = await db.renameGrocery(await who(c), c.req.param('id'), title)
    if (!updated) return c.json({ error: 'Продукта уже нет.' }, 404)
    return c.json(updated)
  })

  app.delete('/api/shopping/groceries/:id', async (c) => {
    const updated = await db.deleteGrocery(await who(c), c.req.param('id'))
    if (!updated) return c.json({ error: 'Продукта уже нет.' }, 404)
    return c.json(updated)
  })

  app.post('/api/shopping/orders', async (c) => {
    const body = await c.req.json().catch(() => null)
    const record = body && typeof body === 'object' ? (body as { title?: unknown; shop?: unknown }) : {}
    const title = parseTitle(record.title)
    const shop = parseShop(record.shop, true)
    return c.json(await db.addOrder(await who(c), title, shop), 201)
  })

  app.patch('/api/shopping/orders/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') throw new InputError('Нечего менять.')
    const record = body as { title?: unknown; shop?: unknown; status?: unknown }
    const patch: { title?: string; shop?: string; status?: OrderStatus } = {}
    if ('title' in record) patch.title = parseTitle(record.title)
    if ('shop' in record) patch.shop = parseShop(record.shop, false)
    if ('status' in record) patch.status = parseOrderStatus(record.status)
    if (Object.keys(patch).length === 0) throw new InputError('Нечего менять.')
    const updated = await db.updateOrder(await who(c), c.req.param('id'), patch)
    if (!updated) return c.json({ error: 'Заказа уже нет.' }, 404)
    return c.json(updated)
  })

  app.delete('/api/shopping/orders/:id', async (c) => {
    const updated = await db.deleteOrder(await who(c), c.req.param('id'))
    if (!updated) return c.json({ error: 'Заказа уже нет.' }, 404)
    return c.json(updated)
  })

  app.get('/api/wallet', async (c) => c.json(await db.wallet(await who(c))))

  app.post('/api/wallet/accounts', async (c) => {
    const body = await c.req.json().catch(() => null)
    const record = body && typeof body === 'object' ? (body as { name?: unknown; kind?: unknown }) : {}
    return c.json(await db.addWalletAccount(await who(c), record.name, record.kind), 201)
  })

  app.patch('/api/wallet/accounts/:id', async (c) => {
    const body = await c.req.json().catch(() => null)
    const record = body && typeof body === 'object' ? (body as { name?: unknown }) : {}
    const updated = await db.renameWalletAccount(await who(c), c.req.param('id'), record.name)
    if (!updated) return c.json({ error: 'Кошелька уже нет.' }, 404)
    return c.json(updated)
  })

  app.delete('/api/wallet/accounts/:id', async (c) => {
    const updated = await db.deleteWalletAccount(await who(c), c.req.param('id'))
    if (!updated) return c.json({ error: 'Кошелька уже нет.' }, 404)
    return c.json(updated)
  })

  app.post('/api/wallet', async (c) => {
    const body = await c.req.json().catch(() => null)
    const record =
      body && typeof body === 'object'
        ? (body as { amount?: unknown; direction?: unknown; note?: unknown; accountId?: unknown; toId?: unknown })
        : {}
    return c.json(
      await db.addWalletEntry(await who(c), record.amount, record.direction, record.note, record.accountId, record.toId),
      201,
    )
  })

  app.delete('/api/wallet/:id', async (c) => {
    const updated = await db.deleteWalletEntry(await who(c), c.req.param('id'))
    if (!updated) return c.json({ error: 'Записи уже нет.' }, 404)
    return c.json(updated)
  })

  app.all('/api/*', (c) => c.json({ error: 'Нет такого запроса.' }, 404))

  app.onError((error, c) => {
    if (error instanceof InputError) {
      const status = error.status === 409 ? 409 : 400
      return c.json({ error: error.message }, status)
    }
    console.error(error)
    return c.json({ error: 'Не сохранилось.' }, 500)
  })

  return { app }
}
