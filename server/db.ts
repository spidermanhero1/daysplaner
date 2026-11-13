import { randomBytes, randomUUID } from 'node:crypto'
import { addDays, addMonths, monthStart, startOfWeek, todayKey } from '../shared/dates.ts'
import { isThemeId, type ThemeId } from '../shared/themes.ts'
import {
  DEFAULT_SHOP,
  PACK_SIZE,
  SMOKE_MAX,
  WALLET_ACCOUNT_MAX,
  type ArchiveGroup,
  type Grocery,
  type MarketOrder,
  type OrderStatus,
  type Priority,
  type Profile,
  type ShoppingPayload,
  type SmokeBreak,
  type SmokeKind,
  type Task,
  type WalletKind,
  type WalletPayload,
} from '../shared/types.ts'
import { InputError } from './errors.ts'
import type { Sql } from './sql.ts'

type TaskRow = {
  id: string
  title: string
  day: string
  parent_id: string | null
  position: number
  priority: string
  done: number
  done_at: string | null
  created_at: string
}

export type TaskPatch = {
  title?: string
  priority?: Priority
  done?: boolean
}

const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const PROFILE_MAX = 12

type ProfileRow = { id: string; name: string; theme: string }
type StockRow = { packs: number; open_cigs: number; joints: number }
type BreakRow = {
  id: string
  day: string
  kind: string
  opened_pack: number
  created_at: string
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    day TEXT NOT NULL,
    parent_id TEXT,
    position INTEGER NOT NULL,
    priority TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_day ON tasks(day, done, position);
  CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id, done, position);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS smoke_stock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    packs INTEGER NOT NULL DEFAULT 0,
    open_cigs INTEGER NOT NULL DEFAULT 0,
    joints INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS smoke_breaks (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    opened_pack INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS smoke_breaks_day ON smoke_breaks(day, created_at);
  CREATE TABLE IF NOT EXISTS groceries (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS market_orders (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    shop TEXT NOT NULL,
    status TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    theme TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wallet_accounts (
    id TEXT PRIMARY KEY,
    profile_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wallet_entries (
    id TEXT PRIMARY KEY,
    profile_id TEXT,
    account_id TEXT,
    amount INTEGER NOT NULL,
    note TEXT NOT NULL,
    transfer_id TEXT,
    created_at TEXT NOT NULL
  );
`

const INDEXES = `
  CREATE INDEX IF NOT EXISTS tasks_profile_day ON tasks(profile_id, day, done, position);
  CREATE INDEX IF NOT EXISTS tasks_profile_parent ON tasks(profile_id, parent_id, done, position);
  CREATE INDEX IF NOT EXISTS smoke_breaks_profile ON smoke_breaks(profile_id, day, created_at);
  CREATE INDEX IF NOT EXISTS groceries_profile ON groceries(profile_id, position);
  CREATE INDEX IF NOT EXISTS orders_profile ON market_orders(profile_id, position);
  CREATE INDEX IF NOT EXISTS wallet_profile ON wallet_entries(profile_id, created_at);
  CREATE INDEX IF NOT EXISTS wallet_accounts_profile ON wallet_accounts(profile_id, position);
`

export function parseProfileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new InputError('Напиши имя.')
  const name = raw.trim()
  if (!name) throw new InputError('Напиши имя.')
  if (name.length > 40) throw new InputError('Слишком длинное имя.')
  return name
}

export function parseTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new InputError('Напиши название.')
  const title = raw.trim()
  if (!title) throw new InputError('Напиши название.')
  if (title.length > 500) throw new InputError('Слишком длинное название.')
  return title
}

export function parseShop(raw: unknown, blankIsDefault: boolean): string {
  if (typeof raw !== 'string') {
    if (blankIsDefault && (raw === undefined || raw === null)) return DEFAULT_SHOP
    throw new InputError('Напиши магазин.')
  }
  const shop = raw.trim()
  if (!shop) {
    if (blankIsDefault) return DEFAULT_SHOP
    throw new InputError('Напиши магазин.')
  }
  if (shop.length > 80) throw new InputError('Слишком длинное название магазина.')
  return shop
}

export function parseOrderStatus(raw: unknown): OrderStatus {
  if (raw !== 'need' && raw !== 'ordered' && raw !== 'arrived') {
    throw new InputError('Статус только надо, заказал или приехало.')
  }
  return raw
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    day: row.day,
    parentId: row.parent_id,
    position: Number(row.position),
    priority: row.priority === 'important' ? 'important' : 'normal',
    done: Number(row.done) === 1,
    doneAt: row.done_at,
    createdAt: row.created_at,
  }
}

function mapGrocery(row: { id: string; title: string; created_at: string }): Grocery {
  return { id: row.id, title: row.title, createdAt: row.created_at }
}

function mapOrder(row: { id: string; title: string; shop: string; status: string; created_at: string }): MarketOrder {
  const status: OrderStatus = row.status === 'ordered' || row.status === 'arrived' ? row.status : 'need'
  return { id: row.id, title: row.title, shop: row.shop, status, createdAt: row.created_at }
}

function mapProfile(row: ProfileRow): Profile {
  return { id: row.id, name: row.name, theme: isThemeId(row.theme) ? row.theme : 'paper' }
}

async function tableColumns(q: Sql, table: string): Promise<string[]> {
  const rows = await q.all<{ name: string }>(`PRAGMA table_info(${table})`)
  return rows.map((column) => column.name)
}

async function tasksForDay(q: Sql, profileId: string, day: string): Promise<Task[]> {
  const rows = await q.all<TaskRow>(
    'SELECT * FROM tasks WHERE profile_id = ? AND day = ? ORDER BY done ASC, position ASC, created_at ASC',
    [profileId, day],
  )
  return rows.map(mapTask)
}

async function tasksForSpan(q: Sql, profileId: string, from: string, to: string): Promise<Task[]> {
  const rows = await q.all<TaskRow>(
    'SELECT * FROM tasks WHERE profile_id = ? AND day >= ? AND day <= ? ORDER BY day ASC, done ASC, position ASC, created_at ASC',
    [profileId, from, to],
  )
  return rows.map(mapTask)
}

async function nextPosition(
  q: Sql,
  profileId: string,
  day: string,
  done: number,
  parentId: string | null,
): Promise<number> {
  const row = parentId
    ? await q.get<{ m: number }>(
        'SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE profile_id = ? AND parent_id = ? AND done = ?',
        [profileId, parentId, done],
      )
    : await q.get<{ m: number }>(
        'SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE profile_id = ? AND day = ? AND done = ? AND parent_id IS NULL',
        [profileId, day, done],
      )
  return Number(row?.m ?? -1) + 1
}

async function stockRow(q: Sql, profileId: string): Promise<StockRow> {
  await q.run(
    'INSERT INTO smoke_stock (profile_id, packs, open_cigs, joints) VALUES (?, 0, 0, 0) ON CONFLICT(profile_id) DO NOTHING',
    [profileId],
  )
  const row = await q.get<StockRow>('SELECT packs, open_cigs, joints FROM smoke_stock WHERE profile_id = ?', [profileId])
  if (!row) throw new InputError('Не сохранилось.')
  return {
    packs: Number(row.packs),
    open_cigs: Number(row.open_cigs),
    joints: Number(row.joints),
  }
}

async function smokeBreaks(q: Sql, profileId: string, day: string): Promise<SmokeBreak[]> {
  const rows = await q.all<Omit<BreakRow, 'opened_pack'>>(
    'SELECT id, day, kind, created_at FROM smoke_breaks WHERE profile_id = ? AND day = ? ORDER BY created_at ASC, rowid ASC',
    [profileId, day],
  )
  return rows.map((row) => ({
    id: row.id,
    day: row.day,
    kind: row.kind === 'joint' ? 'joint' : 'cig',
    createdAt: row.created_at,
  }))
}

async function smokeFor(q: Sql, profileId: string, day: string) {
  const stock = await stockRow(q, profileId)
  const smoked = await q.get<{ cigs: number; joints: number }>(
    `SELECT COALESCE(SUM(kind = 'cig'), 0) AS cigs, COALESCE(SUM(kind = 'joint'), 0) AS joints
     FROM smoke_breaks WHERE profile_id = ?`,
    [profileId],
  )
  const latest = await q.get<BreakRow>(
    'SELECT id, day, kind, opened_pack, created_at FROM smoke_breaks WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [profileId],
  )
  return {
    packSize: PACK_SIZE,
    packs: stock.packs,
    open: stock.open_cigs,
    joints: stock.joints,
    smokedCigs: Number(smoked?.cigs ?? 0),
    smokedJoints: Number(smoked?.joints ?? 0),
    breaks: await smokeBreaks(q, profileId, day),
    latestId: latest?.id ?? null,
  }
}

function parseStockCount(raw: unknown, max: number): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > max) {
    throw new InputError('Число не сходится.')
  }
  return raw
}

async function nextPos(q: Sql, statement: string, profileId: string): Promise<number> {
  const row = await q.get<{ m: number }>(statement, [profileId])
  return Number(row?.m ?? -1) + 1
}

async function shopping(q: Sql, profileId: string): Promise<ShoppingPayload> {
  const groceries = await q.all<{ id: string; title: string; created_at: string }>(
    'SELECT id, title, created_at FROM groceries WHERE profile_id = ? ORDER BY position ASC, created_at ASC',
    [profileId],
  )
  const orders = await q.all<{ id: string; title: string; shop: string; status: string; created_at: string }>(
    `SELECT id, title, shop, status, created_at FROM market_orders WHERE profile_id = ?
     ORDER BY CASE status WHEN 'need' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END, position ASC, created_at ASC`,
    [profileId],
  )
  return { groceries: groceries.map(mapGrocery), orders: orders.map(mapOrder) }
}

const MONEY_MAX = 99_999_999_99

function parseMoney(raw: unknown): number {
  if (typeof raw !== 'string' && typeof raw !== 'number') throw new InputError('Напиши сумму.')
  const text = String(raw).trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) throw new InputError('Сумма не сходится.')
  const [whole, frac = ''] = text.split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MONEY_MAX) throw new InputError('Сумма не сходится.')
  return cents
}

function parseWalletNote(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string') throw new InputError('Напиши, на что.')
  const note = raw.trim()
  if (note.length > 80) throw new InputError('Слишком длинная заметка.')
  return note
}

function parseWalletKind(raw: unknown): WalletKind {
  if (raw !== 'cash' && raw !== 'card' && raw !== 'credit') throw new InputError('Выбери, какой это кошелёк.')
  return raw
}

function parseAccountName(raw: unknown): string {
  if (typeof raw !== 'string') throw new InputError('Напиши имя.')
  const name = raw.trim()
  if (!name) throw new InputError('Напиши имя.')
  if (name.length > 40) throw new InputError('Слишком длинное имя.')
  return name
}

function parseAccountId(raw: unknown): string {
  if (typeof raw !== 'string') throw new InputError('Выбери кошелёк.')
  const id = raw.trim()
  if (!id || id.length > 80) throw new InputError('Выбери кошелёк.')
  return id
}

const WALLET_ENTRY_LIMIT = 300

const DEFAULT_WALLETS: { name: string; kind: WalletKind }[] = [
  { name: 'Наличка', kind: 'cash' },
  { name: 'Карта', kind: 'card' },
  { name: 'Кредит', kind: 'credit' },
]

type WalletAccountRow = { id: string; name: string; kind: string; position: number }
type WalletAmountRow = {
  account_id: string | null
  amount: number
  created_at: string
  transfer_id: string | null
}
type WalletEntryRow = {
  id: string
  account_id: string | null
  amount: number
  note: string
  transfer_id: string | null
  created_at: string
}

function asKind(raw: string): WalletKind {
  return raw === 'card' || raw === 'credit' ? raw : 'cash'
}

function entryDay(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return todayKey(date)
}

async function ensureWallets(q: Sql, profileId: string): Promise<void> {
  const count = await q.get<{ n: number }>('SELECT COUNT(*) AS n FROM wallet_accounts WHERE profile_id = ?', [profileId])
  if (Number(count?.n ?? 0) === 0) {
    const now = new Date().toISOString()
    for (let index = 0; index < DEFAULT_WALLETS.length; index += 1) {
      const item = DEFAULT_WALLETS[index]
      await q.run(
        'INSERT INTO wallet_accounts (id, profile_id, name, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [randomUUID(), profileId, item.name, item.kind, index, now],
      )
    }
  }
  const loose = await q.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM wallet_entries WHERE profile_id = ? AND (account_id IS NULL OR account_id = '')`,
    [profileId],
  )
  if (Number(loose?.n ?? 0) === 0) return
  const cash = await q.get<{ id: string }>(
    `SELECT id FROM wallet_accounts WHERE profile_id = ? AND kind = 'cash' ORDER BY position ASC, created_at ASC LIMIT 1`,
    [profileId],
  )
  const home =
    cash ??
    (await q.get<{ id: string }>(
      'SELECT id FROM wallet_accounts WHERE profile_id = ? ORDER BY position ASC, created_at ASC LIMIT 1',
      [profileId],
    ))
  if (!home) return
  await q.run(
    `UPDATE wallet_entries SET account_id = ? WHERE profile_id = ? AND (account_id IS NULL OR account_id = '')`,
    [home.id, profileId],
  )
}

async function ownedAccount(q: Sql, profileId: string, id: string) {
  return q.get<{ id: string }>('SELECT id FROM wallet_accounts WHERE id = ? AND profile_id = ?', [id, profileId])
}

async function wallet(q: Sql, profileId: string): Promise<WalletPayload> {
  await ensureWallets(q, profileId)
  const accounts = await q.all<WalletAccountRow>(
    'SELECT id, name, kind, position FROM wallet_accounts WHERE profile_id = ? ORDER BY position ASC, created_at ASC',
    [profileId],
  )
  const amounts = await q.all<WalletAmountRow>(
    'SELECT account_id, amount, created_at, transfer_id FROM wallet_entries WHERE profile_id = ?',
    [profileId],
  )
  const today = todayKey()
  const weekFrom = startOfWeek(today)
  const weekTo = addDays(weekFrom, 6)
  const monthFrom = monthStart(today)
  const monthTo = addDays(addMonths(monthFrom, 1), -1)
  const stats = new Map<string, { balance: number; weekIn: number; weekOut: number; monthIn: number; monthOut: number }>()
  for (const account of accounts) {
    stats.set(account.id, { balance: 0, weekIn: 0, weekOut: 0, monthIn: 0, monthOut: 0 })
  }
  let weekIn = 0
  let weekOut = 0
  let monthIn = 0
  let monthOut = 0
  for (const row of amounts) {
    if (!row.account_id) continue
    const stat = stats.get(row.account_id)
    if (!stat) continue
    const amount = Number(row.amount)
    stat.balance += amount
    if (row.transfer_id) continue
    const day = entryDay(row.created_at)
    if (!day) continue
    if (day >= weekFrom && day <= weekTo) {
      if (amount > 0) {
        stat.weekIn += amount
        weekIn += amount
      } else if (amount < 0) {
        stat.weekOut += -amount
        weekOut += -amount
      }
    }
    if (day >= monthFrom && day <= monthTo) {
      if (amount > 0) {
        stat.monthIn += amount
        monthIn += amount
      } else if (amount < 0) {
        stat.monthOut += -amount
        monthOut += -amount
      }
    }
  }

  let held = 0
  let debt = 0
  let overpay = 0
  const mapped = accounts.map((account) => {
    const stat = stats.get(account.id) ?? { balance: 0, weekIn: 0, weekOut: 0, monthIn: 0, monthOut: 0 }
    const kind = asKind(account.kind)
    if (kind === 'credit') {
      if (stat.balance < 0) debt += -stat.balance
      else overpay += stat.balance
    } else held += stat.balance
    return {
      id: account.id,
      name: account.name,
      kind,
      balance: stat.balance,
      weekIn: stat.weekIn,
      weekOut: stat.weekOut,
      monthIn: stat.monthIn,
      monthOut: stat.monthOut,
    }
  })

  const rows = await q.all<WalletEntryRow>(
    `SELECT id, account_id, amount, note, transfer_id, created_at FROM wallet_entries
     WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [profileId, WALLET_ENTRY_LIMIT],
  )
  const total = await q.get<{ n: number }>('SELECT COUNT(*) AS n FROM wallet_entries WHERE profile_id = ?', [profileId])
  return {
    held,
    debt,
    overpay,
    weekIn,
    weekOut,
    monthIn,
    monthOut,
    entryCount: Number(total?.n ?? 0),
    accounts: mapped,
    entries: rows.flatMap((row) =>
      row.account_id
        ? [
            {
              id: row.id,
              accountId: row.account_id,
              amount: Number(row.amount),
              note: row.note,
              transferId: row.transfer_id,
              createdAt: row.created_at,
            },
          ]
        : [],
    ),
  }
}

async function nameTaken(q: Sql, name: string, exceptId?: string): Promise<boolean> {
  const key = name.toLocaleLowerCase('ru-RU')
  const rows = await q.all<ProfileRow>('SELECT id, name, theme FROM profiles ORDER BY position ASC, created_at ASC')
  return rows.some((row) => row.id !== exceptId && row.name.toLocaleLowerCase('ru-RU') === key)
}

async function listProfiles(q: Sql): Promise<Profile[]> {
  const rows = await q.all<ProfileRow>('SELECT id, name, theme FROM profiles ORDER BY position ASC, created_at ASC')
  return rows.map(mapProfile)
}

export async function openDatabase(sql: Sql) {
  await sql.exec(SCHEMA)
  const taskColumns = await tableColumns(sql, 'tasks')
  if (!taskColumns.includes('parent_id')) {
    await sql.exec('ALTER TABLE tasks ADD COLUMN parent_id TEXT')
  }

  const profileCountRow = await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM profiles')
  let defaultProfileId: string
  if (Number(profileCountRow?.n ?? 0) === 0) {
    defaultProfileId = randomUUID()
    await sql.run('INSERT INTO profiles (id, name, theme, position, created_at) VALUES (?, ?, ?, 0, ?)', [
      defaultProfileId,
      'я',
      'paper',
      new Date().toISOString(),
    ])
  } else {
    const first = await sql.get<{ id: string }>('SELECT id FROM profiles ORDER BY position ASC, created_at ASC LIMIT 1')
    if (!first) throw new InputError('Нет профиля.')
    defaultProfileId = first.id
  }

  for (const table of ['tasks', 'smoke_breaks', 'groceries', 'market_orders', 'wallet_entries']) {
    if (!(await tableColumns(sql, table)).includes('profile_id')) {
      await sql.exec(`ALTER TABLE ${table} ADD COLUMN profile_id TEXT`)
    }
    await sql.run(`UPDATE ${table} SET profile_id = ? WHERE profile_id IS NULL OR profile_id = ''`, [defaultProfileId])
  }

  if ((await tableColumns(sql, 'smoke_stock')).includes('id')) {
    await sql.transaction(async (tx) => {
      const legacy = await tx.get<{ packs: number; open_cigs: number; joints: number }>(
        'SELECT packs, open_cigs, joints FROM smoke_stock WHERE id = 1',
      )
      await tx.exec('DROP TABLE IF EXISTS smoke_stock_v2')
      await tx.exec(`
        CREATE TABLE smoke_stock_v2 (
          profile_id TEXT PRIMARY KEY,
          packs INTEGER NOT NULL DEFAULT 0,
          open_cigs INTEGER NOT NULL DEFAULT 0,
          joints INTEGER NOT NULL DEFAULT 0
        );
      `)
      if (legacy) {
        await tx.run('INSERT INTO smoke_stock_v2 (profile_id, packs, open_cigs, joints) VALUES (?, ?, ?, ?)', [
          defaultProfileId,
          legacy.packs,
          legacy.open_cigs,
          legacy.joints,
        ])
      }
      await tx.exec('DROP TABLE smoke_stock')
      await tx.exec('ALTER TABLE smoke_stock_v2 RENAME TO smoke_stock')
    })
  }

  const walletColumns = await tableColumns(sql, 'wallet_entries')
  if (!walletColumns.includes('account_id')) await sql.exec('ALTER TABLE wallet_entries ADD COLUMN account_id TEXT')
  if (!walletColumns.includes('transfer_id')) await sql.exec('ALTER TABLE wallet_entries ADD COLUMN transfer_id TEXT')

  await sql.exec(INDEXES)

  return {
    tasksForDay: (profileId: string, day: string) => tasksForDay(sql, profileId, day),
    tasksForSpan: (profileId: string, from: string, to: string) => tasksForSpan(sql, profileId, from, to),
    addTask: (profileId: string, day: string, title: string) =>
      sql.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO tasks (id, title, day, parent_id, position, priority, done, done_at, created_at, profile_id)
           VALUES (?, ?, ?, NULL, ?, 'normal', 0, NULL, ?, ?)`,
          [randomUUID(), title, day, await nextPosition(tx, profileId, day, 0, null), new Date().toISOString(), profileId],
        )
        return tasksForDay(tx, profileId, day)
      }),
    addSubtask: (profileId: string, parentId: string, title: string) =>
      sql.transaction(async (tx) => {
        const parent = await tx.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND profile_id = ?', [parentId, profileId])
        if (!parent) return null
        if (parent.parent_id) throw new InputError('Подзадачи только у дела.')
        await tx.run(
          `INSERT INTO tasks (id, title, day, parent_id, position, priority, done, done_at, created_at, profile_id)
           VALUES (?, ?, ?, ?, ?, 'normal', 0, NULL, ?, ?)`,
          [
            randomUUID(),
            title,
            parent.day,
            parent.id,
            await nextPosition(tx, profileId, parent.day, 0, parent.id),
            new Date().toISOString(),
            profileId,
          ],
        )
        return { day: parent.day, tasks: await tasksForDay(tx, profileId, parent.day) }
      }),
    updateTask: (profileId: string, id: string, patch: TaskPatch) =>
      sql.transaction(async (tx) => {
        const current = await tx.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND profile_id = ?', [id, profileId])
        if (!current) return null
        let title = current.title
        let priority = current.priority
        let done = Number(current.done)
        let doneAt = current.done_at
        let position = Number(current.position)
        if (patch.title !== undefined) title = parseTitle(patch.title)
        if (patch.priority !== undefined) {
          if (patch.priority !== 'normal' && patch.priority !== 'important') {
            throw new InputError('Приоритет только обычный или важный.')
          }
          priority = patch.priority
        }
        if (patch.done !== undefined && (patch.done ? 1 : 0) !== done) {
          done = patch.done ? 1 : 0
          doneAt = patch.done ? new Date().toISOString() : null
          position = await nextPosition(tx, profileId, current.day, done, current.parent_id)
        }
        await tx.run(
          `UPDATE tasks
           SET title = ?, priority = ?, done = ?, done_at = ?, position = ?
           WHERE id = ? AND profile_id = ?`,
          [title, priority, done, doneAt, position, id, profileId],
        )
        return { day: current.day, tasks: await tasksForDay(tx, profileId, current.day) }
      }),
    deleteTask: (profileId: string, id: string) =>
      sql.transaction(async (tx) => {
        const current = await tx.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND profile_id = ?', [id, profileId])
        if (!current) return null
        if (!current.parent_id) {
          await tx.run('DELETE FROM tasks WHERE parent_id = ? AND profile_id = ?', [id, profileId])
        }
        await tx.run('DELETE FROM tasks WHERE id = ? AND profile_id = ?', [id, profileId])
        return { day: current.day, tasks: await tasksForDay(tx, profileId, current.day) }
      }),
    reorder: (profileId: string, day: string, ids: string[]) =>
      sql.transaction(async (tx) => {
        const open = (
          await tx.all<{ id: string }>(
            'SELECT id FROM tasks WHERE profile_id = ? AND day = ? AND done = 0 AND parent_id IS NULL ORDER BY position ASC, created_at ASC',
            [profileId, day],
          )
        ).map((row) => row.id)
        if (ids.length !== open.length || ids.some((id) => !open.includes(id)) || new Set(ids).size !== ids.length) {
          throw new InputError('Список уже изменился.', 409)
        }
        for (const [index, id] of ids.entries()) {
          await tx.run(
            'UPDATE tasks SET position = ? WHERE id = ? AND profile_id = ? AND day = ? AND done = 0 AND parent_id IS NULL',
            [index, id, profileId, day],
          )
        }
        return tasksForDay(tx, profileId, day)
      }),
    reorderSubtasks: (profileId: string, parentId: string, ids: string[]) =>
      sql.transaction(async (tx) => {
        const parent = await tx.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND profile_id = ?', [parentId, profileId])
        if (!parent || parent.parent_id) return null
        const open = (
          await tx.all<{ id: string }>(
            'SELECT id FROM tasks WHERE profile_id = ? AND parent_id = ? AND done = 0 ORDER BY position ASC, created_at ASC',
            [profileId, parentId],
          )
        ).map((row) => row.id)
        if (ids.length !== open.length || ids.some((id) => !open.includes(id)) || new Set(ids).size !== ids.length) {
          throw new InputError('Список уже изменился.', 409)
        }
        for (const [index, id] of ids.entries()) {
          await tx.run(
            'UPDATE tasks SET position = ? WHERE id = ? AND profile_id = ? AND parent_id = ? AND done = 0',
            [index, id, profileId, parentId],
          )
        }
        return { day: parent.day, tasks: await tasksForDay(tx, profileId, parent.day) }
      }),
    carry: (profileId: string, day: string, to: string) =>
      sql.transaction(async (tx) => {
        const rows = await tx.all<{ id: string }>(
          'SELECT id FROM tasks WHERE profile_id = ? AND day = ? AND done = 0 AND parent_id IS NULL ORDER BY position ASC, created_at ASC',
          [profileId, day],
        )
        let position = (await nextPosition(tx, profileId, to, 0, null)) - 1
        for (const row of rows) {
          position += 1
          await tx.run('UPDATE tasks SET day = ?, position = ? WHERE id = ? AND profile_id = ?', [
            to,
            position,
            row.id,
            profileId,
          ])
          await tx.run('UPDATE tasks SET day = ? WHERE parent_id = ? AND profile_id = ?', [to, row.id, profileId])
        }
        return rows.length
      }),
    archive: async (profileId: string): Promise<ArchiveGroup[]> => {
      const rows = await sql.all<TaskRow>(
        'SELECT * FROM tasks WHERE profile_id = ? AND done = 1 AND parent_id IS NULL ORDER BY day DESC, position ASC, created_at ASC LIMIT 300',
        [profileId],
      )
      const groups: ArchiveGroup[] = []
      for (const row of rows) {
        const task = mapTask(row)
        const last = groups[groups.length - 1]
        if (!last || last.day !== task.day) groups.push({ day: task.day, tasks: [task] })
        else last.tasks.push(task)
      }
      return groups
    },
    createSession: () =>
      sql.transaction(async (tx) => {
        const now = Date.now()
        await tx.run('DELETE FROM sessions WHERE expires_at <= ?', [now])
        const token = randomBytes(32).toString('base64url')
        const expiresAt = now + SESSION_MS
        await tx.run('INSERT INTO sessions (token, expires_at) VALUES (?, ?)', [token, expiresAt])
        return { token, expiresAt }
      }),
    sessionValid: async (token: string) => {
      const now = Date.now()
      await sql.run('DELETE FROM sessions WHERE expires_at <= ?', [now])
      const row = await sql.get<{ token: string }>('SELECT token FROM sessions WHERE token = ? AND expires_at > ?', [
        token,
        now,
      ])
      return row !== undefined
    },
    deleteSession: async (token: string) => {
      await sql.run('DELETE FROM sessions WHERE token = ?', [token])
    },
    smokeFor: (profileId: string, day: string) => smokeFor(sql, profileId, day),
    setSmokeStock: (profileId: string, patch: { packs?: unknown; open?: unknown; joints?: unknown }) =>
      sql.transaction(async (tx) => {
        const packs = parseStockCount(patch.packs, SMOKE_MAX)
        const open = parseStockCount(patch.open, PACK_SIZE)
        const joints = parseStockCount(patch.joints, SMOKE_MAX)
        if (packs === undefined && open === undefined && joints === undefined) {
          throw new InputError('Нечего менять.')
        }
        const current = await stockRow(tx, profileId)
        await tx.run('UPDATE smoke_stock SET packs = ?, open_cigs = ?, joints = ? WHERE profile_id = ?', [
          packs ?? current.packs,
          open ?? current.open_cigs,
          joints ?? current.joints,
          profileId,
        ])
      }),
    addSmokeBreak: (profileId: string, day: string, kind: SmokeKind) =>
      sql.transaction(async (tx) => {
        if (kind !== 'cig' && kind !== 'joint') throw new InputError('Нечего менять.')
        const current = await stockRow(tx, profileId)
        let packs = current.packs
        let open = current.open_cigs
        let joints = current.joints
        let openedPack = 0
        if (kind === 'joint') {
          if (joints <= 0) throw new InputError('Шишек не осталось.')
          joints -= 1
        } else if (open > 0) {
          open -= 1
        } else if (packs > 0) {
          packs -= 1
          open = PACK_SIZE - 1
          openedPack = 1
        } else {
          throw new InputError('Сигарет не осталось.')
        }
        await tx.run(
          `INSERT INTO smoke_breaks (id, day, kind, opened_pack, created_at, profile_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [randomUUID(), day, kind, openedPack, new Date().toISOString(), profileId],
        )
        await tx.run('UPDATE smoke_stock SET packs = ?, open_cigs = ?, joints = ? WHERE profile_id = ?', [
          packs,
          open,
          joints,
          profileId,
        ])
      }),
    undoSmokeBreak: (profileId: string, id: string) =>
      sql.transaction(async (tx) => {
        const latest = await tx.get<BreakRow>(
          'SELECT id, day, kind, opened_pack, created_at FROM smoke_breaks WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
          [profileId],
        )
        if (!latest || latest.id !== id) throw new InputError('Сначала отмени последний.', 409)
        const current = await stockRow(tx, profileId)
        let packs = current.packs
        let open = current.open_cigs
        let joints = current.joints
        if (latest.kind === 'joint') {
          if (joints >= SMOKE_MAX) throw new InputError('Уже максимум.')
          joints += 1
        } else {
          if (open >= PACK_SIZE) throw new InputError('В пачке уже полно.')
          open += 1
          if (Number(latest.opened_pack) === 1 && open === PACK_SIZE) {
            if (packs >= SMOKE_MAX) throw new InputError('Уже максимум.')
            open = 0
            packs += 1
          }
        }
        await tx.run('UPDATE smoke_stock SET packs = ?, open_cigs = ?, joints = ? WHERE profile_id = ?', [
          packs,
          open,
          joints,
          profileId,
        ])
        await tx.run('DELETE FROM smoke_breaks WHERE id = ? AND profile_id = ?', [id, profileId])
      }),
    shopping: (profileId: string) => shopping(sql, profileId),
    addGrocery: (profileId: string, title: string) =>
      sql.transaction(async (tx) => {
        await tx.run('INSERT INTO groceries (id, title, position, created_at, profile_id) VALUES (?, ?, ?, ?, ?)', [
          randomUUID(),
          title,
          await nextPos(
            tx,
            'SELECT COALESCE(MAX(position), -1) AS m FROM groceries WHERE profile_id = ?',
            profileId,
          ),
          new Date().toISOString(),
          profileId,
        ])
        return shopping(tx, profileId)
      }),
    renameGrocery: (profileId: string, id: string, title: string) =>
      sql.transaction(async (tx) => {
        const info = await tx.run('UPDATE groceries SET title = ? WHERE id = ? AND profile_id = ?', [title, id, profileId])
        if (info.changes === 0) return null
        return shopping(tx, profileId)
      }),
    deleteGrocery: (profileId: string, id: string) =>
      sql.transaction(async (tx) => {
        const info = await tx.run('DELETE FROM groceries WHERE id = ? AND profile_id = ?', [id, profileId])
        if (info.changes === 0) return null
        return shopping(tx, profileId)
      }),
    addOrder: (profileId: string, title: string, shop: string) =>
      sql.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO market_orders (id, title, shop, status, position, created_at, profile_id)
           VALUES (?, ?, ?, 'need', ?, ?, ?)`,
          [
            randomUUID(),
            title,
            shop,
            await nextPos(
              tx,
              'SELECT COALESCE(MAX(position), -1) AS m FROM market_orders WHERE profile_id = ?',
              profileId,
            ),
            new Date().toISOString(),
            profileId,
          ],
        )
        return shopping(tx, profileId)
      }),
    updateOrder: (profileId: string, id: string, patch: { title?: string; shop?: string; status?: OrderStatus }) =>
      sql.transaction(async (tx) => {
        const current = await tx.get<{ id: string; title: string; shop: string; status: string; created_at: string }>(
          'SELECT id, title, shop, status, created_at FROM market_orders WHERE id = ? AND profile_id = ?',
          [id, profileId],
        )
        if (!current) return null
        const status =
          patch.status ?? (current.status === 'ordered' || current.status === 'arrived' ? current.status : 'need')
        await tx.run('UPDATE market_orders SET title = ?, shop = ?, status = ? WHERE id = ? AND profile_id = ?', [
          patch.title ?? current.title,
          patch.shop ?? current.shop,
          status,
          id,
          profileId,
        ])
        return shopping(tx, profileId)
      }),
    deleteOrder: (profileId: string, id: string) =>
      sql.transaction(async (tx) => {
        const info = await tx.run('DELETE FROM market_orders WHERE id = ? AND profile_id = ?', [id, profileId])
        if (info.changes === 0) return null
        return shopping(tx, profileId)
      }),
    wallet: (profileId: string) => wallet(sql, profileId),
    addWalletEntry: (
      profileId: string,
      amount: unknown,
      direction: unknown,
      note: unknown,
      accountId: unknown,
      toId: unknown,
    ) =>
      sql.transaction(async (tx) => {
        if (direction !== 'in' && direction !== 'out' && direction !== 'move') throw new InputError('Нечего менять.')
        await ensureWallets(tx, profileId)
        const cents = parseMoney(amount)
        const text = parseWalletNote(note)
        const from = await ownedAccount(tx, profileId, parseAccountId(accountId))
        if (!from) throw new InputError('Кошелька уже нет.')
        const now = new Date().toISOString()
        if (direction === 'move') {
          const target = await ownedAccount(tx, profileId, parseAccountId(toId))
          if (!target) throw new InputError('Кошелька уже нет.')
          if (target.id === from.id) throw new InputError('Это тот же кошелёк.')
          const transferId = randomUUID()
          await tx.run(
            'INSERT INTO wallet_entries (id, profile_id, account_id, amount, note, transfer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [randomUUID(), profileId, from.id, -cents, text, transferId, now],
          )
          await tx.run(
            'INSERT INTO wallet_entries (id, profile_id, account_id, amount, note, transfer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [randomUUID(), profileId, target.id, cents, text, transferId, now],
          )
        } else {
          const signed = direction === 'out' ? -cents : cents
          await tx.run(
            'INSERT INTO wallet_entries (id, profile_id, account_id, amount, note, transfer_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
            [randomUUID(), profileId, from.id, signed, text, now],
          )
        }
        return wallet(tx, profileId)
      }),
    deleteWalletEntry: (profileId: string, id: string) =>
      sql.transaction(async (tx) => {
        const current = await tx.get<{ id: string; transfer_id: string | null }>(
          'SELECT id, transfer_id FROM wallet_entries WHERE id = ? AND profile_id = ?',
          [id, profileId],
        )
        if (!current) return null
        const info = current.transfer_id
          ? await tx.run('DELETE FROM wallet_entries WHERE profile_id = ? AND transfer_id = ?', [
              profileId,
              current.transfer_id,
            ])
          : await tx.run('DELETE FROM wallet_entries WHERE id = ? AND profile_id = ?', [id, profileId])
        if (info.changes === 0) return null
        return wallet(tx, profileId)
      }),
    addWalletAccount: (profileId: string, name: unknown, kind: unknown) =>
      sql.transaction(async (tx) => {
        await ensureWallets(tx, profileId)
        const count = await tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM wallet_accounts WHERE profile_id = ?', [
          profileId,
        ])
        if (Number(count?.n ?? 0) >= WALLET_ACCOUNT_MAX) throw new InputError('Хватит кошельков.')
        const max = await tx.get<{ m: number }>(
          'SELECT COALESCE(MAX(position), -1) AS m FROM wallet_accounts WHERE profile_id = ?',
          [profileId],
        )
        await tx.run(
          'INSERT INTO wallet_accounts (id, profile_id, name, kind, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [randomUUID(), profileId, parseAccountName(name), parseWalletKind(kind), Number(max?.m ?? -1) + 1, new Date().toISOString()],
        )
        return wallet(tx, profileId)
      }),
    renameWalletAccount: (profileId: string, id: string, name: unknown) =>
      sql.transaction(async (tx) => {
        const current = await ownedAccount(tx, profileId, id)
        if (!current) return null
        await tx.run('UPDATE wallet_accounts SET name = ? WHERE id = ? AND profile_id = ?', [
          parseAccountName(name),
          id,
          profileId,
        ])
        return wallet(tx, profileId)
      }),
    deleteWalletAccount: (profileId: string, id: string) =>
      sql.transaction(async (tx) => {
        const current = await ownedAccount(tx, profileId, id)
        if (!current) return null
        const accounts = await tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM wallet_accounts WHERE profile_id = ?', [
          profileId,
        ])
        if (Number(accounts?.n ?? 0) <= 1) throw new InputError('Это последний кошелёк.')
        const entries = await tx.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM wallet_entries WHERE profile_id = ? AND account_id = ?',
          [profileId, id],
        )
        if (Number(entries?.n ?? 0) > 0) throw new InputError('Сначала убери записи.')
        await tx.run('DELETE FROM wallet_accounts WHERE id = ? AND profile_id = ?', [id, profileId])
        return wallet(tx, profileId)
      }),
    listProfiles: () => listProfiles(sql),
    resolveProfile: async (id: string | undefined) => {
      if (id) {
        const row = await sql.get<ProfileRow>('SELECT id, name, theme FROM profiles WHERE id = ?', [id])
        if (row) return row.id
      }
      const first = await sql.get<ProfileRow>(
        'SELECT id, name, theme FROM profiles ORDER BY position ASC, created_at ASC',
      )
      if (!first) throw new InputError('Нет профиля.')
      return first.id
    },
    hasProfile: async (id: string) => {
      const row = await sql.get<ProfileRow>('SELECT id, name, theme FROM profiles WHERE id = ?', [id])
      return row !== undefined
    },
    addProfile: (name: string) =>
      sql.transaction(async (tx) => {
        const count = await tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM profiles')
        if (Number(count?.n ?? 0) >= PROFILE_MAX) throw new InputError('Хватит профилей.')
        if (await nameTaken(tx, name)) throw new InputError('Такое имя уже есть.')
        const id = randomUUID()
        const max = await tx.get<{ m: number }>('SELECT COALESCE(MAX(position), -1) AS m FROM profiles')
        const position = Number(max?.m ?? -1) + 1
        await tx.run('INSERT INTO profiles (id, name, theme, position, created_at) VALUES (?, ?, ?, ?, ?)', [
          id,
          name,
          'paper',
          position,
          new Date().toISOString(),
        ])
        return id
      }),
    updateProfile: (id: string, patch: { name?: string; theme?: ThemeId }) =>
      sql.transaction(async (tx) => {
        const current = await tx.get<ProfileRow>('SELECT id, name, theme FROM profiles WHERE id = ?', [id])
        if (!current) return false
        const name = patch.name ?? current.name
        const theme = patch.theme ?? (isThemeId(current.theme) ? current.theme : 'paper')
        if (patch.name !== undefined && (await nameTaken(tx, name, id))) throw new InputError('Такое имя уже есть.')
        await tx.run('UPDATE profiles SET name = ?, theme = ? WHERE id = ?', [name, theme, id])
        return true
      }),
    deleteProfile: (id: string) =>
      sql.transaction(async (tx) => {
        const current = await tx.get<ProfileRow>('SELECT id, name, theme FROM profiles WHERE id = ?', [id])
        if (!current) return false
        const count = await tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM profiles')
        if (Number(count?.n ?? 0) <= 1) throw new InputError('Это последний профиль.')
        await tx.run('DELETE FROM tasks WHERE profile_id = ?', [id])
        await tx.run('DELETE FROM smoke_breaks WHERE profile_id = ?', [id])
        await tx.run('DELETE FROM smoke_stock WHERE profile_id = ?', [id])
        await tx.run('DELETE FROM groceries WHERE profile_id = ?', [id])
        await tx.run('DELETE FROM market_orders WHERE profile_id = ?', [id])
        await tx.run('DELETE FROM wallet_entries WHERE profile_id = ?', [id])
        await tx.run('DELETE FROM wallet_accounts WHERE profile_id = ?', [id])
        await tx.run('DELETE FROM profiles WHERE id = ?', [id])
        return true
      }),
    close: () => sql.close(),
  }
}

export type AppDatabase = Awaited<ReturnType<typeof openDatabase>>
