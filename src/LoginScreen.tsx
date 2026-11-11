import { useEffect, useState, type FormEvent } from 'react'
import { api } from './api.ts'

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    document.title = 'Вход · Дни'
  }, [])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await api.login(password)
      onSuccess()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не тот пароль.')
      setPending(false)
    }
  }

  return (
    <main className="page">
      <p className="rel">дни</p>
      <h1 className="weekday">Вход</h1>
      <p className="dateline">Список только твой.</p>
      <form className="composer" onSubmit={onSubmit}>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Пароль"
          aria-label="Пароль"
          autoComplete="current-password"
          autoFocus
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Вхожу' : 'Войти'}
        </button>
      </form>
      {error ? <p className="note">{error}</p> : null}
    </main>
  )
}
