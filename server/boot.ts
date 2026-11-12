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

  if (production && !password) {
    console.error('В проде нужен PLANDAYS_PASSWORD.')
    process.exit(1)
  }
  if (onVercel && !process.env.TURSO_DATABASE_URL) {
    console.error('На Vercel нужны TURSO_DATABASE_URL и TURSO_AUTH_TOKEN. База — Marketplace → Turso.')
    process.exit(1)
  }
  if (onVercel && !process.env.TURSO_AUTH_TOKEN) {
    console.error('На Vercel нужен TURSO_AUTH_TOKEN.')
    process.exit(1)
  }
  if (production && !onVercel && !directTls && process.env.PLANDAYS_HTTPS !== '1') {
    console.error(
      'В проде нужен HTTPS: PLANDAYS_TLS_CERT и PLANDAYS_TLS_KEY, либо PLANDAYS_HTTPS=1 за прокси (см. Caddyfile).',
    )
    process.exit(1)
  }
  if (directTls && process.env.PLANDAYS_HTTPS === '1') {
    console.error('Выбери одно: свой сертификат или PLANDAYS_HTTPS=1 за прокси.')
    process.exit(1)
  }
  if (!onVercel && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    console.error('PLANDAYS_PORT должен быть портом.')
    process.exit(1)
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
