import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { addDays, addMonths, monthStart, monthTitleOf, relativeLabel, shortDateOf, startOfWeek, todayKey } from '../shared/dates.ts'
import {
  WALLET_ACCOUNT_MAX,
  type WalletAccount,
  type WalletEntry,
  type WalletKind,
  type WalletPayload,
  type WalletWrite,
} from '../shared/types.ts'

const OPEN_KEY = 'plandays.wallet'

const KINDS: { id: WalletKind; label: string }[] = [
  { id: 'cash', label: 'наличка' },
  { id: 'card', label: 'карта' },
  { id: 'credit', label: 'кредит' },
]

const SCOPES = [
  { id: 'now', label: 'сейчас' },
  { id: 'week', label: 'неделя' },
  { id: 'month', label: 'месяц' },
] as const

type Scope = (typeof SCOPES)[number]['id']

type PurseLine = {
  key: string
  entryId: string
  day: string
  note: string
  amount: number
  signed: boolean
  where: string
}

function money(cents: number, signed = false): string {
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toLocaleString('ru-RU')
  const frac = abs % 100
  const body = frac ? `${whole},${String(frac).padStart(2, '0')}` : whole
  if (!signed || cents === 0) return cents < 0 ? `−${body}` : body
  return cents < 0 ? `−${body}` : `+${body}`
}

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Выбор останется до перезагрузки.
  }
}

function readScope(raw: string): Scope {
  return raw === 'week' || raw === 'month' ? raw : 'now'
}

function kindLabel(kind: WalletKind): string {
  return KINDS.find((item) => item.id === kind)?.label ?? kind
}

function inWord(kind: WalletKind): string {
  return kind === 'credit' ? 'вернул' : 'пришло'
}

function outWord(kind: WalletKind): string {
  return kind === 'credit' ? 'потратил' : 'ушло'
}

function dayOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return todayKey(date)
}

function rangeOf(scope: Scope, today: string): { from: string; to: string } | null {
  if (scope === 'week') {
    const from = startOfWeek(today)
    return { from, to: addDays(from, 6) }
  }
  if (scope === 'month') {
    const from = monthStart(today)
    return { from, to: addDays(addMonths(from, 1), -1) }
  }
  return null
}

function inRange(day: string, range: { from: string; to: string } | null): boolean {
  if (!range) return true
  if (!day) return false
  return day >= range.from && day <= range.to
}

function periodNet(account: WalletAccount, scope: Scope): number | null {
  if (scope === 'week') return account.weekIn - account.weekOut
  if (scope === 'month') return account.monthIn - account.monthOut
  return null
}

function buildLines(
  entries: WalletEntry[],
  accounts: WalletAccount[],
  filterId: string,
  scope: Scope,
  today: string,
): PurseLine[] {
  const names = new Map(accounts.map((item) => [item.id, item.name]))
  const nameOf = (id: string) => names.get(id) ?? 'кошелёк'
  const range = rangeOf(scope, today)
  const byTransfer = new Map<string, WalletEntry[]>()
  for (const entry of entries) {
    if (!entry.transferId) continue
    const list = byTransfer.get(entry.transferId) ?? []
    list.push(entry)
    byTransfer.set(entry.transferId, list)
  }
  const seen = new Set<string>()
  const lines: PurseLine[] = []
  for (const entry of entries) {
    if (entry.transferId) {
      if (seen.has(entry.transferId)) continue
      seen.add(entry.transferId)
      const pair = byTransfer.get(entry.transferId) ?? [entry]
      const from = pair.find((item) => item.amount < 0) ?? pair[0]
      const to = pair.find((item) => item.id !== from.id && item.amount > 0) ?? pair.find((item) => item.id !== from.id) ?? from
      if (filterId !== 'all' && from.accountId !== filterId && to.accountId !== filterId) continue
      const day = dayOf(from.createdAt)
      if (!inRange(day, range)) continue
      lines.push({
        key: entry.transferId,
        entryId: from.id,
        day,
        note: from.note || 'перевод',
        amount: Math.abs(from.amount),
        signed: false,
        where: `${nameOf(from.accountId)} → ${nameOf(to.accountId)}`,
      })
      continue
    }
    if (filterId !== 'all' && entry.accountId !== filterId) continue
    const day = dayOf(entry.createdAt)
    if (!inRange(day, range)) continue
    lines.push({
      key: entry.id,
      entryId: entry.id,
      day,
      note: entry.note || 'без заметки',
      amount: entry.amount,
      signed: true,
      where: filterId === 'all' ? nameOf(entry.accountId) : '',
    })
  }
  return lines
}

function groupLines(lines: PurseLine[], today: string): { day: string; label: string; lines: PurseLine[] }[] {
  const groups: { day: string; label: string; lines: PurseLine[] }[] = []
  for (const line of lines) {
    const last = groups[groups.length - 1]
    if (!last || last.day !== line.day) {
      groups.push({
        day: line.day || line.key,
        label: line.day ? (relativeLabel(line.day, today) ?? shortDateOf(line.day)) : '',
        lines: [line],
      })
    } else last.lines.push(line)
  }
  return groups
}

function PocketName({
  value,
  disabled,
  onSave,
}: {
  value: string
  disabled: boolean
  onSave: (next: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const cancelRef = useRef(false)

  useEffect(() => {
    if (!editing) setText(value)
  }, [value, editing])

  if (!editing) {
    return (
      <button
        type="button"
        className="purse-name"
        disabled={disabled}
        aria-label={`Имя кошелька: ${value}`}
        onClick={() => {
          cancelRef.current = false
          setText(value)
          setEditing(true)
        }}
      >
        {value}
      </button>
    )
  }

  return (
    <input
      className="purse-name-input"
      aria-label="Имя кошелька"
      value={text}
      maxLength={40}
      disabled={disabled}
      autoFocus
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (cancelRef.current) {
          cancelRef.current = false
          setEditing(false)
          setText(value)
          return
        }
        setEditing(false)
        const next = text.trim()
        if (next && next !== value) onSave(next)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          cancelRef.current = true
          event.currentTarget.blur()
        }
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

export function WalletWindow({
  profileId,
  wallet,
  error,
  pending,
  onRetry,
  onAdd,
  onDelete,
  onAddAccount,
  onRenameAccount,
  onDeleteAccount,
}: {
  profileId: string
  wallet: WalletPayload | null
  error: string | null
  pending: boolean
  onRetry: () => void
  onAdd: (entry: WalletWrite) => Promise<boolean>
  onDelete: (id: string) => void
  onAddAccount: (name: string, kind: WalletKind) => Promise<boolean>
  onRenameAccount: (id: string, name: string) => Promise<boolean>
  onDeleteAccount: (id: string) => void
}) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === '1')
  const [scope, setScope] = useState<Scope>(() => readScope(readStored(`plandays.wallet.scope.${profileId}`)))
  const [filter, setFilter] = useState(() => readStored(`plandays.wallet.filter.${profileId}`) || 'all')
  const [picked, setPicked] = useState(() => readStored(`plandays.wallet.picked.${profileId}`))
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [moving, setMoving] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftKind, setDraftKind] = useState<WalletKind>('card')
  const wantRef = useRef<{ name: string; kind: WalletKind; ids: Set<string> } | null>(null)
  const today = todayKey()
  const accounts = wallet?.accounts ?? []
  const filterId = accounts.some((item) => item.id === filter) ? filter : 'all'
  const pickedId = accounts.some((item) => item.id === picked)
    ? picked
    : filterId !== 'all'
      ? filterId
      : (accounts[0]?.id ?? '')
  const account = accounts.find((item) => item.id === pickedId) ?? null
  const filtered = accounts.find((item) => item.id === filterId) ?? null
  const lines = wallet ? buildLines(wallet.entries, accounts, filterId, scope, today) : []
  const groups = groupLines(lines, today)
  const others = accounts.filter((item) => item.id !== account?.id)

  useEffect(() => {
    setScope(readScope(readStored(`plandays.wallet.scope.${profileId}`)))
    setFilter(readStored(`plandays.wallet.filter.${profileId}`) || 'all')
    setPicked(readStored(`plandays.wallet.picked.${profileId}`))
    setMoving(false)
    setAdding(false)
    wantRef.current = null
  }, [profileId])

  useEffect(() => {
    const want = wantRef.current
    if (!want || !wallet) return
    const created = [...wallet.accounts].reverse().find((item) => !want.ids.has(item.id) && item.name === want.name && item.kind === want.kind)
    if (!created) return
    wantRef.current = null
    choose(created.id)
  }, [wallet])

  function toggle() {
    setOpen((current) => {
      const next = !current
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
      return next
    })
  }

  function choose(id: string) {
    setFilter(id)
    setPicked(id)
    setMoving(false)
    writeStored(`plandays.wallet.filter.${profileId}`, id)
    writeStored(`plandays.wallet.picked.${profileId}`, id)
  }

  function chooseAll() {
    setFilter('all')
    setMoving(false)
    writeStored(`plandays.wallet.filter.${profileId}`, 'all')
  }

  function chooseScope(next: Scope) {
    setScope(next)
    writeStored(`plandays.wallet.scope.${profileId}`, next)
  }

  async function send(direction: 'in' | 'out' | 'move', toId?: string) {
    if (!account || pending || !amount.trim()) return
    if (direction === 'move' && !toId) return
    const ok = await onAdd({
      accountId: account.id,
      toId,
      amount: amount.trim(),
      direction,
      note: note.trim(),
    })
    if (!ok) return
    setAmount('')
    setNote('')
    setMoving(false)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null
    const direction = submitter instanceof HTMLButtonElement ? submitter.value : ''
    if (direction !== 'in' && direction !== 'out') return
    await send(direction)
  }

  async function addAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = draftName.trim()
    if (!name || pending) return
    wantRef.current = { name, kind: draftKind, ids: new Set(accounts.map((item) => item.id)) }
    const ok = await onAddAccount(name, draftKind)
    if (!ok) {
      wantRef.current = null
      return
    }
    setDraftName('')
    setAdding(false)
  }

  const flow =
    scope === 'now' || !wallet
      ? null
      : scope === 'week'
        ? { inn: filtered ? filtered.weekIn : wallet.weekIn, out: filtered ? filtered.weekOut : wallet.weekOut }
        : { inn: filtered ? filtered.monthIn : wallet.monthIn, out: filtered ? filtered.monthOut : wallet.monthOut }
  const flowKind = filtered?.kind
  const ledgerTitle = scope === 'month' ? monthTitleOf(today) : scope === 'week' ? 'эта неделя' : 'записи'
  const shut =
    wallet == null
      ? ''
      : wallet.debt > 0 && wallet.held === 0
        ? `долг ${money(wallet.debt)}`
        : wallet.debt > 0
          ? `${money(wallet.held)} · долг ${money(wallet.debt)}`
          : money(wallet.held)

  let body: ReactNode
  if (!wallet && !error) {
    body = <p className="smoke-empty">Открываю</p>
  } else if (!wallet && error) {
    body = (
      <div className="smoke-block">
        <p className="smoke-error">{error}</p>
        <button type="button" className="text" onClick={onRetry}>
          ещё раз
        </button>
      </div>
    )
  } else if (wallet) {
    const book = wallet
    body = (
      <div className="purse-layout">
        <div className="purse-top">
          {error ? <p className="smoke-error">{error}</p> : null}
          <div className="purse-totals">
            <div>
              <p className="smoke-kicker">на руках</p>
              <p className="purse-balance">{money(book.held)}</p>
            </div>
            {book.debt > 0 ? (
              <div>
                <p className="smoke-kicker">долг</p>
                <p className="purse-debt">{money(book.debt)}</p>
              </div>
            ) : null}
            {book.overpay > 0 ? (
              <div>
                <p className="smoke-kicker">переплата</p>
                <p className="purse-over">{money(book.overpay)}</p>
              </div>
            ) : null}
          </div>
          <div className="purse-scopes" role="group" aria-label="Период">
            {SCOPES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={scope === item.id ? 'is-on' : undefined}
                aria-pressed={scope === item.id}
                onClick={() => chooseScope(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {flow ? (
            <p className="purse-flow">
              <span>
                {flowKind === 'credit' ? 'вернул' : 'пришло'} {money(flow.inn)}
              </span>
              <span className="is-out">
                {flowKind === 'credit' ? 'потратил' : 'ушло'} {money(flow.out)}
              </span>
            </p>
          ) : null}
          <div className="purse-pockets" role="group" aria-label="Кошельки">
            <button
              type="button"
              className={filterId === 'all' ? 'purse-pocket is-on' : 'purse-pocket'}
              aria-pressed={filterId === 'all'}
              onClick={chooseAll}
            >
              <span className="purse-pocket-kind">список</span>
              <span className="purse-pocket-name">все</span>
              {scope !== 'now' ? (
                <span className={(scope === 'week' ? book.weekIn - book.weekOut : book.monthIn - book.monthOut) < 0 ? 'purse-pocket-sum purse-out' : 'purse-pocket-sum'}>
                  {money(scope === 'week' ? book.weekIn - book.weekOut : book.monthIn - book.monthOut, true)}
                </span>
              ) : null}
            </button>
            {accounts.map((item) => {
              const net = periodNet(item, scope)
              return (
                <button
                  key={item.id}
                  type="button"
                  className={filterId === item.id ? 'purse-pocket is-on' : 'purse-pocket'}
                  aria-pressed={filterId === item.id}
                  onClick={() => choose(item.id)}
                >
                  <span className="purse-pocket-kind">{kindLabel(item.kind)}</span>
                  <span className="purse-pocket-name">{item.name}</span>
                  <span className={item.balance < 0 ? 'purse-pocket-sum purse-out' : 'purse-pocket-sum'}>{money(item.balance)}</span>
                  {net !== null ? (
                    <span className={net < 0 ? 'purse-pocket-flow purse-out' : 'purse-pocket-flow'}>{money(net, true)}</span>
                  ) : null}
                </button>
              )
            })}
            {accounts.length < WALLET_ACCOUNT_MAX ? (
              <button type="button" className="purse-pocket purse-pocket-add" aria-expanded={adding} aria-label="Новый кошелёк" onClick={() => setAdding((current) => !current)}>
                {adding ? 'закрыть' : '+'}
              </button>
            ) : null}
          </div>
          {adding ? (
            <form className="purse-new" onSubmit={(event) => void addAccount(event)}>
              <input
                value={draftName}
                maxLength={40}
                placeholder="имя"
                aria-label="Имя нового кошелька"
                disabled={pending}
                onChange={(event) => setDraftName(event.target.value)}
              />
              <div className="purse-kinds" role="group" aria-label="Тип кошелька">
                {KINDS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={draftKind === item.id ? 'is-on' : undefined}
                    aria-pressed={draftKind === item.id}
                    disabled={pending}
                    onClick={() => setDraftKind(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <button type="submit" disabled={pending || !draftName.trim()}>
                добавить
              </button>
            </form>
          ) : null}
        </div>
        <div className="purse-main">
          {account ? (
            <>
              <div className="purse-into">
                <span className="smoke-kicker">запись в</span>
                <PocketName value={account.name} disabled={pending} onSave={(name) => void onRenameAccount(account.id, name)} />
                <button type="button" className="text" disabled={pending} onClick={() => onDeleteAccount(account.id)}>
                  убрать
                </button>
              </div>
              <form className="purse-add" onSubmit={(event) => void submit(event)}>
                <input
                  value={amount}
                  inputMode="decimal"
                  maxLength={12}
                  placeholder="сумма"
                  aria-label="Сумма"
                  disabled={pending}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <input
                  value={note}
                  maxLength={80}
                  placeholder="на что"
                  aria-label="На что"
                  disabled={pending}
                  onChange={(event) => setNote(event.target.value)}
                />
                {moving ? (
                  <div className="purse-actions">
                    {others.map((item) => (
                      <button key={item.id} type="button" disabled={pending || !amount.trim()} onClick={() => void send('move', item.id)}>
                        на {item.name}
                      </button>
                    ))}
                    <button type="button" className="is-quiet" onClick={() => setMoving(false)}>
                      назад
                    </button>
                  </div>
                ) : (
                  <div className="purse-actions">
                    <button type="submit" value="in" disabled={pending || !amount.trim()}>
                      {inWord(account.kind)}
                    </button>
                    <button type="submit" value="out" disabled={pending || !amount.trim()}>
                      {outWord(account.kind)}
                    </button>
                    {others.length > 0 ? (
                      <button type="button" className="is-quiet" disabled={pending || !amount.trim()} onClick={() => setMoving(true)}>
                        переложить
                      </button>
                    ) : null}
                  </div>
                )}
              </form>
              {account.kind === 'credit' && !moving ? (
                <p className="smoke-meta">Потратил растит долг. Чтобы закрыть, переложи с карты или налички.</p>
              ) : null}
            </>
          ) : (
            <p className="smoke-empty">Добавь кошелёк.</p>
          )}
        </div>
        <div className="purse-ledger">
          <p className="smoke-kicker">{ledgerTitle}</p>
          {groups.length === 0 ? <p className="smoke-empty">{book.entries.length === 0 ? 'Пока пусто.' : 'Здесь пока пусто.'}</p> : null}
          {groups.map((group) => (
            <section key={group.day}>
              {group.label ? <p className="purse-day">{group.label}</p> : null}
              <ul className="shop-list">
                {group.lines.map((line) => (
                  <li key={line.key}>
                    <div className="shop-line">
                      <span className="shop-name">{line.note}</span>
                      <span className={line.signed && line.amount < 0 ? 'purse-out' : 'purse-in'}>
                        {money(line.amount, line.signed)}
                      </span>
                      <button
                        type="button"
                        className="shop-x"
                        disabled={pending}
                        aria-label={`Убрать ${line.note}`}
                        onClick={() => onDelete(line.entryId)}
                      >
                        ×
                      </button>
                    </div>
                    {line.where ? <p className="shop-shop">{line.where}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {book.entryCount > book.entries.length ? <p className="smoke-meta">Раньше ещё есть, в суммах учтено.</p> : null}
        </div>
      </div>
    )
  }

  return (
    <aside className={open ? 'purse is-wide' : 'purse is-shut'} aria-label="Кошелёк" aria-busy={pending}>
      <header className="smoke-head">
        <div>
          <h2>Кошелёк</h2>
          {!open && shut ? <p className="purse-shut">{shut}</p> : null}
        </div>
        <button type="button" className="text" aria-expanded={open} onClick={toggle}>
          {open ? 'свернуть' : 'открыть'}
        </button>
      </header>
      {open ? <div className="smoke-body">{body}</div> : null}
    </aside>
  )
}
