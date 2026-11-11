import { useEffect } from 'react'
import { dateLineOf, weekdayOf } from '../shared/dates.ts'
import type { ArchiveGroup } from '../shared/types.ts'

type Props = {
  groups: ArchiveGroup[] | null
  error: string | null
  authRequired: boolean
  onOpenDay: (day: string) => void
  onBack: () => void
  onLogout: () => void
}

export function ArchiveScreen({ groups, error, authRequired, onOpenDay, onBack, onLogout }: Props) {
  useEffect(() => {
    document.title = 'Сделанное · Дни'
  }, [])

  return (
    <main className="page">
      <div className="top">
        <button type="button" className="text" onClick={onBack}>
          к календарю
        </button>
        {authRequired ? (
          <button type="button" className="text" onClick={onLogout}>
            выйти
          </button>
        ) : (
          <span />
        )}
      </div>
      <h1 className="weekday">Сделанное</h1>
      {error ? <p className="note">{error}</p> : null}
      {groups === null && !error ? <p className="empty">Открываю</p> : null}
      {groups && groups.length === 0 ? <p className="empty">Пока ничего сделанного.</p> : null}
      {groups?.map((group) => (
        <section key={group.day}>
          <button type="button" className="archive-day" onClick={() => onOpenDay(group.day)}>
            <span>{weekdayOf(group.day)}</span>
            <span className="archive-date">{dateLineOf(group.day)}</span>
          </button>
          <ul className="archive-list">
            {group.tasks.map((task) => (
              <li key={task.id} className={task.priority === 'important' ? 'is-important' : undefined}>
                {task.title}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
