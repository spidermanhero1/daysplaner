import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { resolve } from 'node:path'
import { createApp } from './app.ts'
import { assertRuntime } from './boot.ts'
import { openDatabase } from './db.ts'
import { openSqlite } from './sqlite.ts'
import { openTurso } from './turso.ts'

let runtime: ReturnType<typeof assertRuntime>
try {
  runtime = assertRuntime()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
const sql = process.env.TURSO_DATABASE_URL ? openTurso() : openSqlite(runtime.dbFile)
const database = await openDatabase(sql)
const { app } = createApp(database, runtime)

if (runtime.production) {
  const dist = resolve('dist')
  if (!existsSync(resolve(dist, 'index.html'))) {
    console.error('Нет сборки. Сначала npm run build.')
    process.exit(1)
  }
  app.use('/*', serveStatic({ root: dist }))
  app.get('*', serveStatic({ path: resolve(dist, 'index.html') }))
}

const server = serve({
  fetch: app.fetch,
  port: runtime.port,
  hostname: runtime.hostname,
  ...(runtime.directTls
    ? {
        createServer,
        serverOptions: {
          cert: readFileSync(runtime.certFile!),
          key: readFileSync(runtime.keyFile!),
        },
      }
    : {}),
})

const scheme = runtime.directTls ? 'https' : 'http'
console.log(`Дни: ${scheme}://127.0.0.1:${runtime.port}`)
console.log(process.env.TURSO_DATABASE_URL ? 'База: Turso' : `База: ${resolve(runtime.dbFile)}`)
console.log(runtime.password ? 'Вход: один пароль' : 'Вход: выключен')
if (runtime.directTls) console.log('HTTPS: сертификат')
if (process.env.PLANDAYS_HTTPS === '1') console.log('HTTPS: ждёт прокси, слушаю только localhost')

function shutdown() {
  server.close(() => {
    void database.close().then(() => process.exit(0))
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
