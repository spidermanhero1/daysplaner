import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Sql, SqlArgs } from './sql.ts'

type Sqlite = InstanceType<typeof Database>

function all<T>(db: Sqlite, sql: string, args?: SqlArgs): T[] {
  const stmt = db.prepare(sql)
  if (args === undefined) return stmt.all() as T[]
  if (Array.isArray(args)) return stmt.all(...args) as T[]
  return stmt.all(args) as T[]
}

function get<T>(db: Sqlite, sql: string, args?: SqlArgs): T | undefined {
  const stmt = db.prepare(sql)
  if (args === undefined) return stmt.get() as T | undefined
  if (Array.isArray(args)) return stmt.get(...args) as T | undefined
  return stmt.get(args) as T | undefined
}

function run(db: Sqlite, sql: string, args?: SqlArgs): { changes: number } {
  const stmt = db.prepare(sql)
  const info =
    args === undefined ? stmt.run() : Array.isArray(args) ? stmt.run(...args) : stmt.run(args)
  return { changes: info.changes }
}

export function openSqlite(file: string): Sql {
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 3000')

  let tail: Promise<void> = Promise.resolve()
  function lock<T>(fn: () => Promise<T>): Promise<T> {
    const job = tail.then(fn)
    tail = job.then(
      () => undefined,
      () => undefined,
    )
    return job
  }

  function direct(): Sql {
    return {
      exec: async (sql) => {
        db.exec(sql)
      },
      get: async (sql, args) => get(db, sql, args),
      all: async (sql, args) => all(db, sql, args),
      run: async (sql, args) => run(db, sql, args),
      transaction: () => Promise.reject(new Error('Вложенная транзакция.')),
      close: async () => {},
    }
  }

  return {
    exec: (sql) =>
      lock(async () => {
        db.exec(sql)
      }),
    get: (sql, args) => lock(async () => get(db, sql, args)),
    all: (sql, args) => lock(async () => all(db, sql, args)),
    run: (sql, args) => lock(async () => run(db, sql, args)),
    close: () =>
      lock(async () => {
        db.close()
      }),
    transaction: (fn) =>
      lock(async () => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const result = await fn(direct())
          db.exec('COMMIT')
          return result
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {
            // Откат уже не нужен: соединение само сбросило транзакцию.
          }
          throw error
        }
      }),
  }
}
