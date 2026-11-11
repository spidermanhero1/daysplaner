import Database from 'better-sqlite3'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PACK_SIZE, SMOKE_MAX, type ArchiveGroup, type Priority, type SmokeBreak, type SmokeKind, type Task } from '../shared/types.ts'
import { InputError } from './errors.ts'

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

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    day: row.day,
    parentId: row.parent_id,
    position: row.position,
    priority: row.priority === 'important' ? 'important' : 'normal',
    done: row.done === 1,
    doneAt: row.done_at,
    createdAt: row.created_at,
  }
}

export function parseTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new InputError('Напиши название.')
  const title = raw.trim()
  if (!title) throw new InputError('Напиши название.')
  if (title.length > 500) throw new InputError('Слишком длинное название.')
  return title
}

export function openDatabase(file: string) {
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 3000')
  sqlite.exec(`
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
  `)
  const taskColumns = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
  if (!taskColumns.some((column) => column.name === 'parent_id')) {
    sqlite.exec('ALTER TABLE tasks ADD COLUMN parent_id TEXT')
  }
  sqlite.exec(`
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
  `)

  const tasksForDayStmt = sqlite.prepare(
    'SELECT * FROM tasks WHERE day = ? ORDER BY done ASC, position ASC, created_at ASC',
  )
  const tasksForSpanStmt = sqlite.prepare(
    'SELECT * FROM tasks WHERE day >= ? AND day <= ? ORDER BY day ASC, done ASC, position ASC, created_at ASC',
  )
  const taskByIdStmt = sqlite.prepare('SELECT * FROM tasks WHERE id = ?')
  const insertTaskStmt = sqlite.prepare(
    `INSERT INTO tasks (id, title, day, parent_id, position, priority, done, done_at, created_at)
     VALUES (@id, @title, @day, @parent_id, @position, 'normal', 0, NULL, @created_at)`,
  )
  const maxPositionStmt = sqlite.prepare(
    'SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE day = ? AND done = ? AND parent_id IS NULL',
  )
  const maxChildPositionStmt = sqlite.prepare(
    'SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE parent_id = ? AND done = ?',
  )
  const updateTaskStmt = sqlite.prepare(
    `UPDATE tasks
     SET title = @title, priority = @priority, done = @done, done_at = @done_at, position = @position
     WHERE id = @id`,
  )
  const deleteTaskStmt = sqlite.prepare('DELETE FROM tasks WHERE id = ?')
  const deleteChildrenStmt = sqlite.prepare('DELETE FROM tasks WHERE parent_id = ?')
  const openIdsStmt = sqlite.prepare(
    'SELECT id FROM tasks WHERE day = ? AND done = 0 AND parent_id IS NULL ORDER BY position ASC, created_at ASC',
  )
  const openChildIdsStmt = sqlite.prepare(
    'SELECT id FROM tasks WHERE parent_id = ? AND done = 0 ORDER BY position ASC, created_at ASC',
  )
  const setPositionStmt = sqlite.prepare(
    'UPDATE tasks SET position = ? WHERE id = ? AND day = ? AND done = 0 AND parent_id IS NULL',
  )
  const setChildPositionStmt = sqlite.prepare(
    'UPDATE tasks SET position = ? WHERE id = ? AND parent_id = ? AND done = 0',
  )
  const moveTaskStmt = sqlite.prepare('UPDATE tasks SET day = ?, position = ? WHERE id = ?')
  const moveChildrenStmt = sqlite.prepare('UPDATE tasks SET day = ? WHERE parent_id = ?')
  const archiveStmt = sqlite.prepare(
    'SELECT * FROM tasks WHERE done = 1 AND parent_id IS NULL ORDER BY day DESC, position ASC, created_at ASC LIMIT 300',
  )
  const insertSessionStmt = sqlite.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)')
  const deleteExpiredStmt = sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?')
  const sessionStmt = sqlite.prepare('SELECT token FROM sessions WHERE token = ? AND expires_at > ?')
  const deleteSessionStmt = sqlite.prepare('DELETE FROM sessions WHERE token = ?')
  const ensureStockStmt = sqlite.prepare(
    'INSERT INTO smoke_stock (id, packs, open_cigs, joints) VALUES (1, 0, 0, 0) ON CONFLICT(id) DO NOTHING',
  )
  const stockStmt = sqlite.prepare('SELECT packs, open_cigs, joints FROM smoke_stock WHERE id = 1')
  const updateStockStmt = sqlite.prepare('UPDATE smoke_stock SET packs = ?, open_cigs = ?, joints = ? WHERE id = 1')
  const breaksForDayStmt = sqlite.prepare(
    'SELECT id, day, kind, created_at FROM smoke_breaks WHERE day = ? ORDER BY created_at ASC, rowid ASC',
  )
  const latestBreakStmt = sqlite.prepare(
    'SELECT id, day, kind, opened_pack, created_at FROM smoke_breaks ORDER BY created_at DESC, rowid DESC LIMIT 1',
  )
  const smokedStmt = sqlite.prepare(
    `SELECT COALESCE(SUM(kind = 'cig'), 0) AS cigs, COALESCE(SUM(kind = 'joint'), 0) AS joints FROM smoke_breaks`,
  )
  const insertBreakStmt = sqlite.prepare(
    `INSERT INTO smoke_breaks (id, day, kind, opened_pack, created_at)
     VALUES (@id, @day, @kind, @opened_pack, @created_at)`,
  )
  const deleteBreakStmt = sqlite.prepare('DELETE FROM smoke_breaks WHERE id = ?')

  type StockRow = { packs: number; open_cigs: number; joints: number }
  type BreakRow = {
    id: string
    day: string
    kind: string
    opened_pack: number
    created_at: string
  }

  function stockRow(): StockRow {
    ensureStockStmt.run()
    return stockStmt.get() as StockRow
  }

  function smokeBreaks(day: string): SmokeBreak[] {
    return (breaksForDayStmt.all(day) as Omit<BreakRow, 'opened_pack'>[]).map((row) => ({
      id: row.id,
      day: row.day,
      kind: row.kind === 'joint' ? 'joint' : 'cig',
      createdAt: row.created_at,
    }))
  }

  function smokeFor(day: string) {
    const stock = stockRow()
    const smoked = smokedStmt.get() as { cigs: number; joints: number }
    const latest = latestBreakStmt.get() as BreakRow | undefined
    return {
      packSize: PACK_SIZE,
      packs: stock.packs,
      open: stock.open_cigs,
      joints: stock.joints,
      smokedCigs: Number(smoked.cigs),
      smokedJoints: Number(smoked.joints),
      breaks: smokeBreaks(day),
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

  const setSmokeStock = sqlite.transaction((patch: { packs?: unknown; open?: unknown; joints?: unknown }) => {
    const packs = parseStockCount(patch.packs, SMOKE_MAX)
    const open = parseStockCount(patch.open, PACK_SIZE)
    const joints = parseStockCount(patch.joints, SMOKE_MAX)
    if (packs === undefined && open === undefined && joints === undefined) {
      throw new InputError('Нечего менять.')
    }
    const current = stockRow()
    updateStockStmt.run(packs ?? current.packs, open ?? current.open_cigs, joints ?? current.joints)
  })

  const addSmokeBreak = sqlite.transaction((day: string, kind: SmokeKind) => {
    if (kind !== 'cig' && kind !== 'joint') throw new InputError('Нечего менять.')
    const current = stockRow()
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
    insertBreakStmt.run({
      id: randomUUID(),
      day,
      kind,
      opened_pack: openedPack,
      created_at: new Date().toISOString(),
    })
    updateStockStmt.run(packs, open, joints)
  })

  const undoSmokeBreak = sqlite.transaction((id: string) => {
    const latest = latestBreakStmt.get() as BreakRow | undefined
    if (!latest || latest.id !== id) throw new InputError('Сначала отмени последний.', 409)
    const current = stockRow()
    let packs = current.packs
    let open = current.open_cigs
    let joints = current.joints
    if (latest.kind === 'joint') {
      if (joints >= SMOKE_MAX) throw new InputError('Уже максимум.')
      joints += 1
    } else {
      if (open >= PACK_SIZE) throw new InputError('В пачке уже полно.')
      open += 1
      if (latest.opened_pack === 1 && open === PACK_SIZE) {
        if (packs >= SMOKE_MAX) throw new InputError('Уже максимум.')
        open = 0
        packs += 1
      }
    }
    updateStockStmt.run(packs, open, joints)
    deleteBreakStmt.run(id)
  })

  function tasksForDay(day: string): Task[] {
    return (tasksForDayStmt.all(day) as TaskRow[]).map(mapTask)
  }

  function tasksForSpan(from: string, to: string): Task[] {
    return (tasksForSpanStmt.all(from, to) as TaskRow[]).map(mapTask)
  }

  function nextPosition(day: string, done: number, parentId: string | null): number {
    const row = (
      parentId ? maxChildPositionStmt.get(parentId, done) : maxPositionStmt.get(day, done)
    ) as { m: number }
    return Number(row.m) + 1
  }

  const addTask = sqlite.transaction((day: string, title: string) => {
    insertTaskStmt.run({
      id: randomUUID(),
      title,
      day,
      parent_id: null,
      position: nextPosition(day, 0, null),
      created_at: new Date().toISOString(),
    })
    return tasksForDay(day)
  })

  const addSubtask = sqlite.transaction((parentId: string, title: string) => {
    const parent = taskByIdStmt.get(parentId) as TaskRow | undefined
    if (!parent) return null
    if (parent.parent_id) throw new InputError('Подзадачи только у дела.')
    insertTaskStmt.run({
      id: randomUUID(),
      title,
      day: parent.day,
      parent_id: parent.id,
      position: nextPosition(parent.day, 0, parent.id),
      created_at: new Date().toISOString(),
    })
    return { day: parent.day, tasks: tasksForDay(parent.day) }
  })

  const updateTask = sqlite.transaction((id: string, patch: TaskPatch) => {
    const current = taskByIdStmt.get(id) as TaskRow | undefined
    if (!current) return null
    let title = current.title
    let priority = current.priority
    let done = current.done
    let doneAt = current.done_at
    let position = current.position
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
      position = nextPosition(current.day, done, current.parent_id)
    }
    updateTaskStmt.run({
      id,
      title,
      priority,
      done,
      done_at: doneAt,
      position,
    })
    return { day: current.day, tasks: tasksForDay(current.day) }
  })

  const deleteTask = sqlite.transaction((id: string) => {
    const current = taskByIdStmt.get(id) as TaskRow | undefined
    if (!current) return null
    if (!current.parent_id) deleteChildrenStmt.run(id)
    deleteTaskStmt.run(id)
    return { day: current.day, tasks: tasksForDay(current.day) }
  })

  const reorder = sqlite.transaction((day: string, ids: string[]) => {
    const open = (openIdsStmt.all(day) as { id: string }[]).map((row) => row.id)
    if (ids.length !== open.length || ids.some((id) => !open.includes(id)) || new Set(ids).size !== ids.length) {
      throw new InputError('Список уже изменился.', 409)
    }
    ids.forEach((id, index) => setPositionStmt.run(index, id, day))
    return tasksForDay(day)
  })

  const reorderSubtasks = sqlite.transaction((parentId: string, ids: string[]) => {
    const parent = taskByIdStmt.get(parentId) as TaskRow | undefined
    if (!parent || parent.parent_id) return null
    const open = (openChildIdsStmt.all(parentId) as { id: string }[]).map((row) => row.id)
    if (ids.length !== open.length || ids.some((id) => !open.includes(id)) || new Set(ids).size !== ids.length) {
      throw new InputError('Список уже изменился.', 409)
    }
    ids.forEach((id, index) => setChildPositionStmt.run(index, id, parentId))
    return { day: parent.day, tasks: tasksForDay(parent.day) }
  })

  const carry = sqlite.transaction((day: string, to: string) => {
    const rows = openIdsStmt.all(day) as { id: string }[]
    let position = nextPosition(to, 0, null) - 1
    for (const row of rows) {
      position += 1
      moveTaskStmt.run(to, position, row.id)
      moveChildrenStmt.run(to, row.id)
    }
    return rows.length
  })

  function archive(): ArchiveGroup[] {
    const rows = archiveStmt.all() as TaskRow[]
    const groups: ArchiveGroup[] = []
    for (const row of rows) {
      const task = mapTask(row)
      const last = groups[groups.length - 1]
      if (!last || last.day !== task.day) groups.push({ day: task.day, tasks: [task] })
      else last.tasks.push(task)
    }
    return groups
  }

  function createSession(): { token: string; expiresAt: number } {
    const now = Date.now()
    deleteExpiredStmt.run(now)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + SESSION_MS
    insertSessionStmt.run(token, expiresAt)
    return { token, expiresAt }
  }

  function sessionValid(token: string): boolean {
    const now = Date.now()
    deleteExpiredStmt.run(now)
    return sessionStmt.get(token, now) !== undefined
  }

  function deleteSession(token: string): void {
    deleteSessionStmt.run(token)
  }

  function close(): void {
    sqlite.close()
  }

  return {
    tasksForDay,
    tasksForSpan,
    addTask,
    addSubtask,
    updateTask,
    deleteTask,
    reorder,
    reorderSubtasks,
    carry,
    archive,
    createSession,
    sessionValid,
    deleteSession,
    smokeFor,
    setSmokeStock,
    addSmokeBreak,
    undoSmokeBreak,
    close,
  }
}

export type AppDatabase = ReturnType<typeof openDatabase>
