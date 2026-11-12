import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Profile } from '../shared/types.ts'

type Props = {
  profiles: Profile[]
  currentId: string
  onSwitch: (id: string) => Promise<boolean>
  onAdd: (name: string) => Promise<boolean>
  onRename: (name: string) => Promise<boolean>
  onDelete: () => Promise<boolean>
  onClose: () => void
}

type Dialog = 'add' | 'rename'

export function profileLetter(name: string) {
  const first = [...name.trim()][0]
  return first ? first.toLocaleUpperCase('ru') : '?'
}

export function ProfileMenu({ profiles, currentId, onSwitch, onAdd, onRename, onDelete, onClose }: Props) {
  const current = profiles.find((item) => item.id === currentId) ?? profiles[0]
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [draft, setDraft] = useState('')
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setArmed(false)
  }, [current?.id])

  useEffect(() => {
    if (!dialog) return
    const frame = requestAnimationFrame(() => {
      field.current?.focus()
      if (dialog === 'rename') field.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [dialog])

  function openDialog(next: Dialog) {
    setArmed(false)
    setDraft(next === 'rename' ? (current?.name ?? '') : '')
    setDialog(next)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const name = draft.trim()
    if (!name || busy || !dialog) return
    if (dialog === 'rename' && name === current?.name) {
      setDialog(null)
      return
    }
    setBusy(true)
    const ok = dialog === 'add' ? await onAdd(name) : await onRename(name)
    setBusy(false)
    if (!ok) return
    setDialog(null)
    if (dialog === 'add') onClose()
  }

  async function remove() {
    if (busy) return
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    const ok = await onDelete()
    setBusy(false)
    if (ok) onClose()
  }

  function keep(event: ReactPointerEvent) {
    event.stopPropagation()
  }

  const host = dialog ? document.querySelector('main.cal') : null

  return (
    <>
      <div className="profile-list" role="listbox" aria-label="Кто">
        {profiles.map((item) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={item.id === currentId}
            disabled={busy}
            onClick={() => {
              if (item.id === currentId) onClose()
              else
                void onSwitch(item.id).then((ok) => {
                  if (ok) onClose()
                })
            }}
          >
            <span className="profile-mark" aria-hidden="true">
              {profileLetter(item.name)}
            </span>
            <span className="profile-name">{item.name}</span>
          </button>
        ))}
      </div>
      <div className="profile-actions">
        <button type="button" className="text" disabled={busy} onClick={() => openDialog('add')}>
          новый профиль
        </button>
        <button type="button" className="text" disabled={busy} onClick={() => openDialog('rename')}>
          переименовать
        </button>
        {profiles.length > 1 ? (
          <button
            type="button"
            className="text profile-remove"
            data-armed={armed ? 'true' : undefined}
            disabled={busy}
            onClick={() => void remove()}
          >
            {armed ? `точно убрать «${current?.name ?? ''}»` : `убрать «${current?.name ?? ''}»`}
          </button>
        ) : null}
      </div>
      {dialog && host
        ? createPortal(
            <div
              className="profile-scrim"
              onPointerDown={keep}
              onClick={() => {
                if (!busy) setDialog(null)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                event.stopPropagation()
                if (!busy) setDialog(null)
              }}
            >
              <form
                className="profile-window"
                role="dialog"
                aria-modal="true"
                aria-label={dialog === 'add' ? 'Новый профиль' : 'Переименовать'}
                onClick={(event) => event.stopPropagation()}
                onSubmit={(event) => void submit(event)}
              >
                <h2>{dialog === 'add' ? 'Новый профиль' : 'Переименовать'}</h2>
                <input
                  ref={field}
                  value={draft}
                  maxLength={40}
                  placeholder="имя"
                  aria-label="Имя"
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="profile-window-actions">
                  <button type="button" className="text" disabled={busy} onClick={() => setDialog(null)}>
                    отмена
                  </button>
                  <button
                    type="submit"
                    className="is-primary"
                    disabled={busy || !draft.trim() || (dialog === 'rename' && draft.trim() === current?.name)}
                  >
                    {dialog === 'add' ? 'создать' : 'сохранить'}
                  </button>
                </div>
              </form>
            </div>,
            host,
          )
        : null}
    </>
  )
}
