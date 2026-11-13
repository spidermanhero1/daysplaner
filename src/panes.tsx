import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react'
import { dateLineOf, relativeLabel, weekdayOf } from '../shared/dates.ts'
import type { Priority, Task } from '../shared/types.ts'

export function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return Number(a.done) - Number(b.done)
    if (a.position !== b.position) return a.position - b.position
    if (a.createdAt < b.createdAt) return -1
    if (a.createdAt > b.createdAt) return 1
    return 0
  })
}

export function stepMark(list: Task[]): string | null {
  if (list.length === 0) return null
  const done = list.filter((task) => task.done).length
  return `${done}/${list.length}`
}

function stepNote(list: Task[]): string | null {
  if (list.length === 0) return null
  const done = list.filter((task) => task.done).length
  return `${done} из ${list.length}`
}

type RowProps = {
  task: Task
  open: boolean
  mark?: string | null
  showPriority?: boolean
  onOpen?: () => void
  onToggle: (done: boolean) => void
  onPriority?: () => void
  onRename: (title: string) => void
  onDelete: () => void
}

export function DayPane({
  day,
  today,
  tasks,
  openedId,
  covered,
  sheet,
  draft,
  inputRef,
  stepsOf,
  onClose,
  onDraft,
  onSubmit,
  onOpenTask,
  onToggle,
  onPriority,
  onRename,
  onDelete,
}: {
  day: string
  today: string
  tasks: Task[]
  openedId: string | null
  covered: boolean
  sheet: boolean
  draft: string
  inputRef?: RefObject<HTMLInputElement | null>
  stepsOf: (id: string) => Task[]
  onClose: () => void
  onDraft: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onOpenTask: (id: string) => void
  onToggle: (id: string, done: boolean) => void
  onPriority: (id: string, priority: Priority) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const ordered = sortTasks(tasks)
  const open = ordered.filter((task) => !task.done)
  const done = ordered.filter((task) => task.done)
  const place = relativeLabel(day, today)
  return (
    <aside
      className={sheet ? 'pane pane-day is-sheet' : 'pane pane-day'}
      aria-label={weekdayOf(day)}
      aria-hidden={covered ? true : undefined}
      inert={covered ? true : undefined}
    >
      <header className="pane-head">
        {sheet ? (
          <button type="button" className="text pane-back" onClick={onClose}>
            к календарю
          </button>
        ) : null}
        {place ? <p className="pane-kicker">{place}</p> : null}
        <h2 className="pane-heading">{weekdayOf(day)}</h2>
        <p className="pane-date">{dateLineOf(day)}</p>
      </header>
      <div className="pane-scroll">
        {tasks.length === 0 ? <p className="pane-empty">Пока пусто.</p> : null}
        {open.length > 0 ? (
          <SortableContext items={open.map((task) => task.id)} strategy={verticalListSortingStrategy}>
            <ul className="pane-list">
              {open.map((task) => (
                <SortableRow
                  key={task.id}
                  task={task}
                  open={task.id === openedId}
                  mark={stepMark(stepsOf(task.id))}
                  showPriority
                  onOpen={() => onOpenTask(task.id)}
                  onToggle={(next) => onToggle(task.id, next)}
                  onPriority={() => onPriority(task.id, task.priority === 'important' ? 'normal' : 'important')}
                  onRename={(title) => onRename(task.id, title)}
                  onDelete={() => onDelete(task.id)}
                />
              ))}
            </ul>
          </SortableContext>
        ) : null}
        {done.length > 0 ? (
          <>
            <p className="pane-done-label">сделано</p>
            <ul className="pane-list">
              {done.map((task) => (
                <PaneRow
                  key={task.id}
                  task={task}
                  open={task.id === openedId}
                  mark={stepMark(stepsOf(task.id))}
                  showPriority
                  onOpen={() => onOpenTask(task.id)}
                  onToggle={(next) => onToggle(task.id, next)}
                  onPriority={() => onPriority(task.id, task.priority === 'important' ? 'normal' : 'important')}
                  onRename={(title) => onRename(task.id, title)}
                  onDelete={() => onDelete(task.id)}
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <form className="pane-compose" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="дело"
          aria-label={`Новое дело, ${weekdayOf(day)} ${dateLineOf(day)}`}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="sentences"
          maxLength={500}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.currentTarget.blur()
          }}
        />
        <button type="submit" disabled={draft.trim() === ''}>
          Добавить
        </button>
      </form>
    </aside>
  )
}

export function TaskPane({
  task,
  day,
  today,
  steps,
  pickedId,
  sheet,
  closeLabel,
  inputRef,
  onClose,
  onToggle,
  onPriority,
  onRename,
  onDelete,
  onToggleStep,
  onRenameStep,
  onDeleteStep,
  onAdd,
}: {
  task: Task
  day: string
  today: string
  steps: Task[]
  pickedId: string | null
  sheet: boolean
  closeLabel: string
  inputRef?: RefObject<HTMLInputElement | null>
  onClose: () => void
  onToggle: (done: boolean) => void
  onPriority: () => void
  onRename: (title: string) => void
  onDelete: () => void
  onToggleStep: (id: string, done: boolean) => void
  onRenameStep: (id: string, title: string) => void
  onDeleteStep: (id: string) => void
  onAdd: (title: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const skipSave = useRef(false)
  const open = steps.filter((step) => !step.done)
  const done = steps.filter((step) => step.done)
  const note = stepNote(steps)
  const place = relativeLabel(day, today) ?? dateLineOf(day)

  useEffect(() => {
    setDraft('')
    setEditing(false)
  }, [task.id])

  useEffect(() => {
    if (!editing) setTitle(task.title)
  }, [task.title, editing])

  function commitTitle() {
    setEditing(false)
    if (skipSave.current) {
      skipSave.current = false
      setTitle(task.title)
      return
    }
    const next = title.trim()
    if (!next || next === task.title) {
      setTitle(task.title)
      return
    }
    onRename(next)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const next = draft.trim()
    if (!next) return
    setDraft('')
    const ok = await onAdd(next)
    if (!ok) setDraft((current) => (current ? current : next))
  }

  return (
    <aside className={sheet ? 'pane pane-task is-sheet' : 'pane pane-task'} aria-label={task.title}>
      <header className="pane-head">
        <button type="button" className="text pane-back" onClick={onClose}>
          {closeLabel}
        </button>
        <p className="pane-kicker">
          {place}
          {note ? ` · ${note}` : ''}
        </p>
        {editing ? (
          <input
            className="pane-title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                skipSave.current = true
                setTitle(task.title)
                event.currentTarget.blur()
              }
            }}
            aria-label="Название"
            autoFocus
            maxLength={500}
          />
        ) : (
          <button type="button" className={task.done ? 'pane-task-title is-done' : 'pane-task-title'} onClick={() => setEditing(true)}>
            {task.title}
          </button>
        )}
        <div className="pane-actions">
          <button type="button" onClick={() => onToggle(!task.done)}>
            {task.done ? 'вернуть' : 'готово'}
          </button>
          <button type="button" className={task.priority === 'important' ? 'is-on' : undefined} onClick={onPriority}>
            важно
          </button>
          <button type="button" onClick={onDelete}>
            убрать
          </button>
        </div>
      </header>
      <div className="pane-scroll">
        {steps.length === 0 ? <p className="pane-empty">Добавь шаги этого дела.</p> : null}
        {open.length > 0 ? (
          <SortableContext items={open.map((step) => step.id)} strategy={verticalListSortingStrategy}>
            <ul className="pane-list">
              {open.map((step) => (
                <SortableRow
                  key={step.id}
                  task={step}
                  open={step.id === pickedId}
                  onToggle={(next) => onToggleStep(step.id, next)}
                  onRename={(value) => onRenameStep(step.id, value)}
                  onDelete={() => onDeleteStep(step.id)}
                />
              ))}
            </ul>
          </SortableContext>
        ) : null}
        {done.length > 0 ? (
          <>
            {open.length > 0 ? <p className="pane-done-label">сделано</p> : null}
            <ul className="pane-list">
              {done.map((step) => (
                <PaneRow
                  key={step.id}
                  task={step}
                  open={step.id === pickedId}
                  onToggle={(next) => onToggleStep(step.id, next)}
                  onRename={(value) => onRenameStep(step.id, value)}
                  onDelete={() => onDeleteStep(step.id)}
                />
              ))}
            </ul>
          </>
        ) : null}
      </div>
      <form className="pane-compose" onSubmit={(event) => void submit(event)}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="шаг"
          aria-label={`Шаг для ${task.title}`}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="sentences"
          maxLength={500}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.currentTarget.blur()
          }}
        />
        <button type="submit" disabled={draft.trim() === ''}>
          Добавить
        </button>
      </form>
    </aside>
  )
}

function SortableRow(props: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.task.id })
  return (
    <PaneRow
      {...props}
      setNodeRef={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : undefined,
      }}
      leading={
        <button type="button" className="pane-handle" aria-label="Перетащить" {...attributes} {...listeners}>
          ⋮⋮
        </button>
      }
    />
  )
}

function PaneRow({
  task,
  open,
  mark,
  showPriority,
  onOpen,
  onToggle,
  onPriority,
  onRename,
  onDelete,
  leading,
  setNodeRef,
  style,
}: RowProps & {
  leading?: ReactNode
  setNodeRef?: (node: HTMLElement | null) => void
  style?: CSSProperties
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(task.title)
  const skipSave = useRef(false)

  useEffect(() => {
    if (!editing) setValue(task.title)
  }, [task.title, editing])

  function commit() {
    setEditing(false)
    if (skipSave.current) {
      skipSave.current = false
      setValue(task.title)
      return
    }
    const next = value.trim()
    if (!next || next === task.title) {
      setValue(task.title)
      return
    }
    onRename(next)
  }

  const names = ['pane-row']
  if (!showPriority && !onOpen) names.push('is-step')
  if (task.priority === 'important') names.push('is-important')
  if (task.done) names.push('is-done')
  if (open) names.push('is-open')

  return (
    <li ref={setNodeRef} className={names.join(' ')} style={style} data-id={task.id}>
      {leading ?? <span className="pane-handle" />}
      <label className="pane-check">
        <input
          type="checkbox"
          checked={task.done}
          onChange={(event) => onToggle(event.target.checked)}
          aria-label={task.done ? 'Вернуть в список' : 'Сделано'}
        />
      </label>
      {editing ? (
        <input
          className="pane-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              skipSave.current = true
              setValue(task.title)
              event.currentTarget.blur()
            }
          }}
          aria-label="Название"
          autoFocus
          maxLength={500}
        />
      ) : (
        <button type="button" className="pane-name" onClick={() => (onOpen ? onOpen() : setEditing(true))}>
          {task.title}
        </button>
      )}
      {mark ? (
        <button type="button" className="pane-mark" onClick={onOpen} aria-label={`Подзадачи, ${mark}`}>
          {mark}
        </button>
      ) : onOpen ? (
        <span className="pane-mark" />
      ) : null}
      {showPriority ? (
        <button
          type="button"
          className={task.priority === 'important' ? 'pane-pri is-on' : 'pane-pri'}
          aria-pressed={task.priority === 'important'}
          aria-label={task.priority === 'important' ? 'Снять важность' : 'Отметить важным'}
          onClick={onPriority}
        >
          важно
        </button>
      ) : null}
      <button type="button" className="pane-x" aria-label="Убрать" onClick={onDelete}>
        ×
      </button>
    </li>
  )
}
