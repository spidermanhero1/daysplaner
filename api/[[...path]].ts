import { createApp } from '../server/app.ts'
import { assertRuntime } from '../server/boot.ts'
import { openDatabase } from '../server/db.ts'
import { openTurso } from '../server/turso.ts'

const runtime = assertRuntime()
const database = await openDatabase(openTurso())
const { app } = createApp(database, runtime)

const handler = (request: Request) => app.fetch(request)

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
export const HEAD = handler
