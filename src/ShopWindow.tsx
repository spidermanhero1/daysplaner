import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { DEFAULT_SHOP, type OrderStatus, type ShoppingPayload } from '../shared/types.ts'

const OPEN_KEY = 'plandays.shop'

const STATUSES: { id: OrderStatus; label: string }[] = [
  { id: 'need', label: 'надо' },
  { id: 'ordered', label: 'заказал' },
  { id: 'arrived', label: 'приехало' },
]

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

function NameField({
  value,
  label,
  className,
  inputClassName,
  maxLength,
  disabled,
  onSave,
}: {
  value: string
  label: string
  className: string
  inputClassName: string
  maxLength: number
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
        className={className}
        disabled={disabled}
        aria-label={`${label}: ${value}`}
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
      className={inputClassName}
      aria-label={label}
      value={text}
      maxLength={maxLength}
      disabled={disabled}
      autoFocus
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (cancelRef.current) {
          cancelRef.current = false
          return
        }
        setEditing(false)
        const next = text.trim()
        if (next && next !== value) onSave(next)
        else setText(value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelRef.current = true
          setText(value)
          setEditing(false)
        }
      }}
    />
  )
}

export function ShopWindow({
  shopping,
  error,
  pending,
  onRetry,
  onAddGrocery,
  onRenameGrocery,
  onBuyGrocery,
  onAddOrder,
  onUpdateOrder,
  onDeleteOrder,
}: {
  shopping: ShoppingPayload | null
  error: string | null
  pending: boolean
  onRetry: () => void
  onAddGrocery: (title: string) => Promise<boolean>
  onRenameGrocery: (id: string, title: string) => void
  onBuyGrocery: (id: string) => void
  onAddOrder: (title: string, shop: string) => Promise<boolean>
  onUpdateOrder: (id: string, patch: { title?: string; shop?: string; status?: OrderStatus }) => void
  onDeleteOrder: (id: string) => void
}) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === '1')
  const [grocery, setGrocery] = useState('')
  const [orderTitle, setOrderTitle] = useState('')
  const [shop, setShop] = useState(DEFAULT_SHOP)
  const groceries = shopping?.groceries ?? []
  const orders = shopping?.orders ?? []
  const active = orders.filter((order) => order.status !== 'arrived')
  const arrived = orders.filter((order) => order.status === 'arrived')
  const need = orders.filter((order) => order.status === 'need').length
  const ordered = orders.filter((order) => order.status === 'ordered').length
  const summary = [
    groceries.length ? countLabel(groceries.length, 'продукт', 'продукта', 'продуктов') : null,
    need + ordered ? countLabel(need + ordered, 'заказ', 'заказа', 'заказов') : null,
    arrived.length ? `${arrived.length} приехало` : null,
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

  async function submitGrocery(event: FormEvent) {
    event.preventDefault()
    const title = grocery.trim()
    if (!title || pending) return
    if (await onAddGrocery(title)) setGrocery('')
  }

  async function submitOrder(event: FormEvent) {
    event.preventDefault()
    const title = orderTitle.trim()
    if (!title || pending) return
    const nextShop = shop.trim()
    if (await onAddOrder(title, nextShop)) {
      setOrderTitle('')
      if (!nextShop) setShop(DEFAULT_SHOP)
    }
  }

  let body: ReactNode
  if (!shopping && !error) {
    body = <p className="smoke-empty">Открываю</p>
  } else if (!shopping && error) {
    body = (
      <div className="smoke-block">
        <p className="smoke-error">{error}</p>
        <button type="button" className="text" onClick={onRetry}>
          ещё раз
        </button>
      </div>
    )
  } else {
    body = (
      <>
        {error ? <p className="smoke-error">{error}</p> : null}
        <section className="smoke-block" aria-label="Продукты">
          <h3>Продукты</h3>
          <form className="shop-add" onSubmit={(event) => void submitGrocery(event)}>
            <input
              value={grocery}
              maxLength={500}
              placeholder="продукт"
              aria-label="Продукт"
              disabled={pending}
              onChange={(event) => setGrocery(event.target.value)}
            />
            <button type="submit" disabled={pending || !grocery.trim()}>
              добавить
            </button>
          </form>
          {groceries.length === 0 ? <p className="smoke-empty">Пока нечего покупать.</p> : null}
          {groceries.length > 0 ? (
            <ul className="shop-list">
              {groceries.map((item) => (
                <li key={item.id}>
                  <div className="shop-line">
                    <NameField
                      value={item.title}
                      label="Продукт"
                      className="shop-name"
                      inputClassName="shop-name-input"
                      maxLength={500}
                      disabled={pending}
                      onSave={(title) => onRenameGrocery(item.id, title)}
                    />
                    <button
                      type="button"
                      className="shop-buy"
                      disabled={pending}
                      aria-label={`Купил ${item.title}`}
                      onClick={() => onBuyGrocery(item.id)}
                    >
                      купил
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section className="smoke-block" aria-label="Маркеты">
          <h3>Маркеты</h3>
          <form className="shop-add shop-add-order" onSubmit={(event) => void submitOrder(event)}>
            <input
              value={orderTitle}
              maxLength={500}
              placeholder="заказ"
              aria-label="Заказ"
              disabled={pending}
              onChange={(event) => setOrderTitle(event.target.value)}
            />
            <input
              value={shop}
              maxLength={80}
              placeholder="магазин"
              aria-label="Магазин"
              disabled={pending}
              onChange={(event) => setShop(event.target.value)}
            />
            <button type="submit" disabled={pending || !orderTitle.trim()}>
              добавить
            </button>
          </form>
          {orders.length === 0 ? <p className="smoke-empty">Заказов нет.</p> : null}
          {active.length > 0 ? (
            <ul className="shop-list">
              {active.map((order) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  pending={pending}
                  onUpdate={onUpdateOrder}
                  onDelete={onDeleteOrder}
                />
              ))}
            </ul>
          ) : null}
          {arrived.length > 0 ? <p className="smoke-kicker shop-split">Приехало</p> : null}
          {arrived.length > 0 ? (
            <ul className="shop-list">
              {arrived.map((order) => (
                <OrderRow
                  key={order.id}
                  order={order}
                  pending={pending}
                  onUpdate={onUpdateOrder}
                  onDelete={onDeleteOrder}
                />
              ))}
            </ul>
          ) : null}
        </section>
      </>
    )
  }

  return (
    <aside className={open ? 'shop' : 'shop is-shut'} aria-label="Покупки" aria-busy={pending}>
      <header className="smoke-head">
        <div>
          <h2>Покупки</h2>
          {!open && summary ? <p className="smoke-summary">{summary}</p> : null}
        </div>
        <button type="button" className="text" aria-expanded={open} onClick={toggle}>
          {open ? 'свернуть' : 'открыть'}
        </button>
      </header>
      {open ? <div className="smoke-body">{body}</div> : null}
    </aside>
  )
}

function OrderRow({
  order,
  pending,
  onUpdate,
  onDelete,
}: {
  order: ShoppingPayload['orders'][number]
  pending: boolean
  onUpdate: (id: string, patch: { title?: string; shop?: string; status?: OrderStatus }) => void
  onDelete: (id: string) => void
}) {
  return (
    <li className={order.status === 'arrived' ? 'shop-order is-arrived' : 'shop-order'}>
      <div className="shop-line">
        <NameField
          value={order.title}
          label="Заказ"
          className="shop-name"
          inputClassName="shop-name-input"
          maxLength={500}
          disabled={pending}
          onSave={(title) => onUpdate(order.id, { title })}
        />
        <button
          type="button"
          className="shop-x"
          disabled={pending}
          aria-label={`Убрать ${order.title}`}
          onClick={() => onDelete(order.id)}
        >
          ×
        </button>
      </div>
      <NameField
        value={order.shop}
        label="Магазин"
        className="shop-shop"
        inputClassName="shop-shop-input"
        maxLength={80}
        disabled={pending}
        onSave={(shop) => onUpdate(order.id, { shop })}
      />
      <div className="shop-status" role="group" aria-label={`Статус: ${order.title}`}>
        {STATUSES.map((status) => (
          <button
            key={status.id}
            type="button"
            className={order.status === status.id ? 'is-on' : ''}
            aria-pressed={order.status === status.id}
            disabled={pending}
            onClick={() => {
              if (order.status !== status.id) onUpdate(order.id, { status: status.id })
            }}
          >
            {status.label}
          </button>
        ))}
      </div>
    </li>
  )
}
