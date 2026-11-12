export type Runtime = {
  password: string
  production: boolean
  onVercel: boolean
  directTls: boolean
  behindProxy: boolean
  port: number
  hostname: string
  certFile: string | undefined
  keyFile: string | undefined
  dbFile: string
}

function fail(message: string): never {
  throw new Error(message)
}

function missingEnv(names: string[]): string {
  return names.length === 1 ? `Не задан ${names[0]}.` : `Не заданы ${names.join(', ')}.`
}

export function assertRuntime(): Runtime {
  const onVercel = process.env.VERCEL === '1'
  const password = process.env.PLANDAYS_PASSWORD ?? ''
  const production = process.env.NODE_ENV === 'production' || onVercel
  const port = Number(process.env.PLANDAYS_PORT ?? 8787)
  const certFile = process.env.PLANDAYS_TLS_CERT
  const keyFile = process.env.PLANDAYS_TLS_KEY
  const directTls = Boolean(certFile && keyFile)
  const dbFile = process.env.PLANDAYS_DB ?? 'data/plandays.sqlite'
  const behindProxy = process.env.PLANDAYS_HTTPS === '1' || onVercel

  if (onVercel) {
    const missing = [
      !password ? 'PLANDAYS_PASSWORD' : '',
      !process.env.TURSO_DATABASE_URL ? 'TURSO_DATABASE_URL' : '',
      !process.env.TURSO_AUTH_TOKEN ? 'TURSO_AUTH_TOKEN' : '',
    ].filter((name) => name !== '')
    if (missing.length) fail(missingEnv(missing))
  } else if (production && !password) {
    fail('В проде нужен PLANDAYS_PASSWORD.')
  }
  if (production && !onVercel && !directTls && process.env.PLANDAYS_HTTPS !== '1') {
    fail('В проде нужен HTTPS: PLANDAYS_TLS_CERT и PLANDAYS_TLS_KEY, либо PLANDAYS_HTTPS=1 за прокси (см. Caddyfile).')
  }
  if (directTls && process.env.PLANDAYS_HTTPS === '1') {
    fail('Выбери одно: свой сертификат или PLANDAYS_HTTPS=1 за прокси.')
  }
  if (!onVercel && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    fail('PLANDAYS_PORT должен быть портом.')
  }

  const hostname =
    process.env.PLANDAYS_HOST ?? (production && process.env.PLANDAYS_HTTPS === '1' ? '127.0.0.1' : '0.0.0.0')

  return {
    password,
    production,
    onVercel,
    directTls,
    behindProxy,
    port,
    hostname,
    certFile,
    keyFile,
    dbFile,
  }
}
