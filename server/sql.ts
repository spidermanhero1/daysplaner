export type SqlArgs = readonly unknown[] | Record<string, unknown>

export type Sql = {
  exec(sql: string): Promise<void>
  get<T>(sql: string, args?: SqlArgs): Promise<T | undefined>
  all<T>(sql: string, args?: SqlArgs): Promise<T[]>
  run(sql: string, args?: SqlArgs): Promise<{ changes: number }>
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  close(): Promise<void>
}
