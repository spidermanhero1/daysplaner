import { createApp } from '../server/app.ts'
import { assertRuntime } from '../server/boot.ts'
import { openDatabase } from '../server/db.ts'
import { openTurso } from '../server/turso.ts'

let opening: Promise<ReturnType<typeof createApp>['app']> | null = null

function openApp() {
  if (!opening) {
    opening = (async () => {
      const runtime = assertRuntime()
      const database = await openDatabase(openTurso())
      return createApp(database, runtime).app
    })().catch((error: unknown) => {
      opening = null
      throw error
    })
  }
  return opening
}

function requestForApp(request: Request): Request {
  const url = new URL(request.url)
  if (url.pathname !== '/api' && url.pathname !== '/api/index') return request
  const hinted = url.searchParams.get('__path')
  if (!hinted || !hinted.startsWith('/api/') || hinted.includes('..')) return request
  url.pathname = hinted
  url.searchParams.delete('__path')
  return new Request(url, request)
}

async function handler(request: Request): Promise<Response> {
  try {
    const app = await openApp()
    return await app.fetch(requestForApp(request))
  } catch (error) {
    console.error(error)
    const message = error instanceof Error && error.message ? error.message : 'Не открылось.'
    return Response.json({ error: message }, { status: 500 })
  }
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const OPTIONS = handler
export const HEAD = handler
export default { fetch: handler }
