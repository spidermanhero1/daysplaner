import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { relativeLabel, shortDateOf } from '../shared/dates.ts'
import { PACK_SIZE, SMOKE_MAX, type SmokeKind, type SmokePayload } from '../shared/types.ts'

const OPEN_KEY = 'plandays.smoke'

function plural(value: number, one: string, few: string, many: string): string {
  const abs = Math.abs(value) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return many
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few
  return many
}

function countLabel(value: number, one: string, few: string, many: string): string {
  return `${value} ${plural(value, one, few, many)}`
}

function Stepper({
  label,
  value,
  max,
  hint,
  disabled,
  onChange,
}: {
  label: string
  value: number
  max: number
  hint?: string
  disabled: boolean
  onChange: (next: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  function commit(raw: string) {
    const next = Number(raw)
    if (!Number.isInteger(next) || next < 0 || next > max || next === value) {
      setText(String(value))
      return
    }
    onChange(next)
  }

  return (
    <div className="smoke-step">
      <span className="smoke-step-label">{label}</span>
      <span className="smoke-step-ctrl">
        <button
          type="button"
          aria-label={`Меньше, ${label}`}
          disabled={disabled || value <= 0}
          onClick={() => onChange(value - 1)}
        >
          −
        </button>
        <input
          value={text}
          inputMode="numeric"
          aria-label={label}
          disabled={disabled}
          maxLength={3}
          onFocus={() => setFocused(true)}
          onChange={(event) => setText(event.target.value.replace(/\D/g, '').slice(0, 3))}
          onBlur={() => {
            setFocused(false)
            commit(text)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              setText(String(value))
              event.currentTarget.blur()
            }
          }}
        />
        <button
          type="button"
          aria-label={`Больше, ${label}`}
          disabled={disabled || value >= max}
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
        {hint ? <span className="smoke-hint">{hint}</span> : null}
      </span>
    </div>
  )
}

export function SmokeWindow({
  day,
  today,
  smoke,
  error,
  pending,
  onRetry,
  onStock,
  onBreak,
  onUndo,
}: {
  day: string
  today: string
  smoke: SmokePayload | null
  error: string | null
  pending: boolean
  onRetry: () => void
  onStock: (patch: { packs?: number; open?: number; joints?: number }) => void
  onBreak: (kind: SmokeKind) => void
  onUndo: (id: string) => void
}) {
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(OPEN_KEY)
    if (saved === '0') return false
    if (saved === '1') return true
    return window.matchMedia('(min-width: 721px)').matches
  })
  const place = relativeLabel(day, today) ?? shortDateOf(day)
  const ready = Boolean(smoke && smoke.day === day)
  const locked = pending || !ready
  const cigsLeft = smoke ? smoke.packs * smoke.packSize + smoke.open : 0
  const dayBreaks = ready && smoke ? smoke.breaks : []
  const dayCigs = dayBreaks.filter((item) => item.kind === 'cig').length
  const dayJoints = dayBreaks.filter((item) => item.kind === 'joint').length
  const summary = [
    smoke ? countLabel(cigsLeft, 'сигарета', 'сигареты', 'сигарет') : null,
    smoke ? countLabel(smoke.joints, 'шишка', 'шишки', 'шишек') : null,
  ]
    .filter(Boolean)
    .join(' · ')

  function toggle() {
    setOpen((current) => {
      const next = !current
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
      return next
    })
  }

  const scheduleNote = [
    dayCigs ? countLabel(dayCigs, 'сигарета', 'сигареты', 'сигарет') : null,
    dayJoints ? countLabel(dayJoints, 'шишка', 'шишки', 'шишек') : null,
  ]
    .filter(Boolean)
    .join(', ')

  let body: ReactNode
  let actions: ReactNode = null
  if (!smoke && !error) {
    body = <p className="smoke-empty">Открываю</p>
  } else if (!smoke && error) {
    body = (
      <div className="smoke-block">
        <p className="smoke-error">{error}</p>
        <button type="button" className="text" onClick={onRetry}>
          ещё раз
        </button>
      </div>
    )
  } else if (smoke) {
    const fresh = smoke.packs === 0 && smoke.open === 0 && smoke.joints === 0 && smoke.smokedCigs === 0 && smoke.smokedJoints === 0
    body = (
      <>
        {error ? <p className="smoke-error">{error}</p> : null}
        {fresh ? <p className="smoke-empty">Сначала запиши, сколько есть.</p> : null}
        <section className="smoke-block" aria-label="Сигареты">
          <h3>Сигареты</h3>
          <p className="smoke-left">{countLabel(cigsLeft, 'сигарета', 'сигареты', 'сигарет')}</p>
          <Stepper
            label="пачки"
            value={smoke.packs}
            max={SMOKE_MAX}
            disabled={locked}
            onChange={(packs) => onStock({ packs })}
          />
          <Stepper
            label="в открытой"
            value={smoke.open}
            max={smoke.packSize || PACK_SIZE}
            hint={`из ${smoke.packSize || PACK_SIZE}`}
            disabled={locked}
            onChange={(openCount) => onStock({ open: openCount })}
          />
          {smoke.smokedCigs > 0 ? (
            <p className="smoke-meta">скурено {countLabel(smoke.smokedCigs, 'сигарета', 'сигареты', 'сигарет')}</p>
          ) : null}
        </section>
        <section className="smoke-block" aria-label="Шишки">
          <h3>Шишки</h3>
          <Stepper
            label="осталось"
            value={smoke.joints}
            max={SMOKE_MAX}
            disabled={locked}
            onChange={(joints) => onStock({ joints })}
          />
          {smoke.smokedJoints > 0 ? (
            <p className="smoke-meta">скурено {countLabel(smoke.smokedJoints, 'шишка', 'шишки', 'шишек')}</p>
          ) : null}
        </section>
        <section className="smoke-block" aria-label="Расписание">
          <h3>Расписание</h3>
          <p className="smoke-meta">
            {place}
            {ready && scheduleNote ? ` · ${scheduleNote}` : ''}
          </p>
          {!ready ? <p className="smoke-empty">Открываю</p> : null}
          {ready && dayBreaks.length === 0 ? <p className="smoke-empty">Пока пусто.</p> : null}
          {ready && dayBreaks.length > 0 ? (
            <ol className="smoke-list">
              {dayBreaks.map((item) => (
                <li key={item.id}>
                  <span>{item.kind === 'joint' ? 'шишка' : 'сигарета'}</span>
                  {item.id === smoke.latestId ? (
                    <button type="button" aria-label="Отменить последний перекур" disabled={pending} onClick={() => onUndo(item.id)}>
                      ×
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      </>
    )
    actions = (
      <div className="smoke-actions">
        <button type="button" disabled={locked || cigsLeft <= 0} onClick={() => onBreak('cig')}>
          сигарета
        </button>
        <button type="button" disabled={locked || smoke.joints <= 0} onClick={() => onBreak('joint')}>
          шишка
        </button>
      </div>
    )
  }

  return createPortal(
    <aside className={open ? 'smoke' : 'smoke is-shut'} aria-label="Перекуры" aria-busy={pending || !ready}>
      <header className="smoke-head">
        <div>
          <p className="smoke-kicker">{place}</p>
          <h2>Перекуры</h2>
          {!open && summary ? <p className="smoke-summary">{summary}</p> : null}
        </div>
        <button type="button" className="text" aria-expanded={open} onClick={toggle}>
          {open ? 'свернуть' : 'открыть'}
        </button>
      </header>
      {open ? <div className="smoke-body">{body}</div> : null}
      {open ? actions : null}
    </aside>,
    document.body,
  )
}
