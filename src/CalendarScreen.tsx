import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  addDays,
  dateLineOf,
  monthTitleOf,
  relativeLabel,
  shortDateOf,
  weekdayOf,
} from '../shared/dates.ts'
import type { Priority, Profile, Task } from '../shared/types.ts'
import { DayPane, TaskPane, sortTasks, stepMark } from './panes.tsx'
import { ProfileMenu, profileLetter } from './ProfileMenu.tsx'
import { THEMES, themeTone, type ThemeId } from './themes.ts'

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']

type Zoom = 'month' | 'week'

type Props = {
  today: string
  cursor: string
  zoom: Zoom
  selected: string
  days: string[]
  tasks: Task[] | null
  note: string | null
  error: string | null
  authRequired: boolean
  onLogout: () => void
  onSelect: (day: string) => void
  onCursor: (day: string) => void
  onPage: (delta: number) => void
  onZoom: (zoom: Zoom) => void
  onToday: () => void
  onArchive: () => void
  onRetry: () => void
  onAdd: (day: string, title: string) => Promise<boolean>
  onToggle: (id: string, done: boolean) => void
  onPriority: (id: string, priority: Priority) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onReorder: (day: string, ids: string[]) => void
  onAddSubtask: (parentId: string, title: string) => Promise<boolean>
  onReorderSubtasks: (parentId: string, ids: string[]) => void
  onCarry: () => void
  profiles: Profile[]
  profileId: string
  profileName: string
  theme: ThemeId
  onTheme: (id: ThemeId) => void
  onSwitchProfile: (id: string) => Promise<boolean>
  onAddProfile: (name: string) => Promise<boolean>
  onRenameProfile: (name: string) => Promise<boolean>
  onDeleteProfile: () => Promise<boolean>
}

function weekTitle(days: string[], today: string): string {
  const start = days[0]
  const end = days[days.length - 1]
  const y1 = start.slice(0, 4)
  const y2 = end.slice(0, 4)
  if (y1 !== y2) return `${shortDateOf(start)} ${y1} – ${shortDateOf(end)} ${y2}`
  if (y1 !== today.slice(0, 4)) return `${shortDateOf(start)} – ${shortDateOf(end)} ${y1}`
  return `${shortDateOf(start)} – ${shortDateOf(end)}`
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const apply = () => setMatches(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [query])
  return matches
}

export function CalendarScreen({
  today,
  cursor,
  zoom,
  selected,
  days,
  tasks,
  note,
  error,
  authRequired,
  onLogout,
  onSelect,
  onCursor,
  onPage,
  onZoom,
  onToday,
  onArchive,
  onRetry,
  onAdd,
  onToggle,
  onPriority,
  onRename,
  onDelete,
  onReorder,
  onAddSubtask,
  onReorderSubtasks,
  onCarry,
  profiles,
  profileId,
  profileName,
  theme,
  onTheme,
  onSwitchProfile,
  onAddProfile,
  onRenameProfile,
  onDeleteProfile,
}: Props) {
  const narrow = useMedia('(max-width: 720px)')
  const split = useMedia('(min-width: 1000px)')
  const roomy = useMedia('(min-width: 1400px)')
  const [sheet, setSheet] = useState<'day' | 'task' | null>(null)
  const [openedId, setOpenedId] = useState<string | null>(null)
  const [subPicked, setSubPicked] = useState<string | null>(null)
  const docked = narrow && zoom === 'month' && !sheet
  const [picked, setPicked] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [dockEdit, setDockEdit] = useState<string | null>(null)
  const [themesOpen, setThemesOpen] = useState(false)
  const [profilesOpen, setProfilesOpen] = useState(false)
  const keepPick = useRef<string | null>(null)
  const themeBtn = useRef<HTMLButtonElement>(null)
  const themePop = useRef<HTMLDivElement>(null)
  const profileBtn = useRef<HTMLButtonElement>(null)
  const profilePop = useRef<HTMLDivElement>(null)
  const wantFocus = useRef(false)
  const didAuto = useRef(false)
  const addRef = useRef<HTMLInputElement>(null)
  const subRef = useRef<HTMLInputElement>(null)
  const focusSub = useRef(false)
  const skipDock = useRef(false)
  const boardRef = useRef<HTMLDivElement>(null)
  const ignoreClick = useRef(false)
  const dropSwipe = useRef<(() => void) | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  )

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const task of tasks ?? []) {
      if (task.parentId) continue
      const list = map.get(task.day)
      if (list) list.push(task)
      else map.set(task.day, [task])
    }
    return map
  }, [tasks])

  const stepsOf = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const task of tasks ?? []) {
      if (!task.parentId) continue
      const list = map.get(task.parentId)
      if (list) list.push(task)
      else map.set(task.parentId, [task])
    }
    for (const [id, list] of map) map.set(id, sortTasks(list))
    return (id: string) => map.get(id) ?? []
  }, [tasks])

  const weeks: string[][] = []
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7))

  const title = zoom === 'month' ? monthTitleOf(cursor) : weekTitle(days, today)
  const selectedTasks = byDay.get(selected) ?? []
  const selectedOpen = selectedTasks.filter((task) => !task.done)
  const pickedTask = tasks?.find((task) => task.id === picked && !task.parentId) ?? null
  const openedTask = tasks?.find((task) => task.id === openedId && !task.parentId) ?? null
  const taskCoversDay = Boolean(openedTask) && !roomy
  const showDay = (split || sheet !== null) && !taskCoversDay
  const showTask = Boolean(openedTask) && (roomy || split || sheet === 'task')
  const dragOnCalendar = !showDay
  const place = relativeLabel(selected, today) ?? shortDateOf(selected)

  useEffect(() => {
    document.title = `${title} · ${profileName}`
  }, [title, profileName])

  useEffect(() => {
    if (!themesOpen && !profilesOpen) return
    function onPointer(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (themesOpen && (themeBtn.current?.contains(target) || themePop.current?.contains(target))) return
      if (target instanceof Element && target.closest('.profile-scrim')) return
      if (profilesOpen && (profileBtn.current?.contains(target) || profilePop.current?.contains(target))) return
      setThemesOpen(false)
      setProfilesOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [themesOpen, profilesOpen])

  useEffect(() => {
    setDrafts({})
    setPicked(null)
    setOpenedId(null)
    setSheet(null)
    setProfilesOpen(false)
    setThemesOpen(false)
  }, [profileId])

  useEffect(() => {
    if (keepPick.current) {
      setPicked(keepPick.current)
      keepPick.current = null
      return
    }
    setPicked(null)
  }, [selected])

  useEffect(() => {
    setDockEdit(null)
  }, [picked])

  useEffect(() => {
    setSubPicked(null)
  }, [openedId])

  useEffect(() => {
    if (!focusSub.current || !openedId) return
    focusSub.current = false
    subRef.current?.focus()
  }, [openedId])

  useEffect(() => {
    if (!openedId || !tasks) return
    const task = tasks.find((item) => item.id === openedId && !item.parentId)
    if (task && task.day === selected) return
    setOpenedId(null)
    setSheet((current) => (current === 'task' ? 'day' : current))
  }, [openedId, selected, tasks])

  useEffect(() => {
    if (!picked) return
    document.querySelector(`[data-id="${picked}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [picked])

  useEffect(() => {
    if (!wantFocus.current) return
    wantFocus.current = false
    addRef.current?.focus()
  }, [selected, zoom, docked])

  useEffect(() => {
    return () => dropSwipe.current?.()
  }, [])

  useEffect(() => {
    const node = boardRef.current
    if (!node) return
    function eat(event: MouseEvent) {
      if (!ignoreClick.current) return
      event.preventDefault()
      event.stopPropagation()
      ignoreClick.current = false
    }
    node.addEventListener('click', eat, true)
    return () => node.removeEventListener('click', eat, true)
  }, [])

  useEffect(() => {
    if (didAuto.current || tasks === null) return
    if (!window.matchMedia('(pointer: fine)').matches) return
    if (document.activeElement && document.activeElement !== document.body) return
    didAuto.current = true
    addRef.current?.focus()
  }, [tasks])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) return
      const target = event.target
      if (target instanceof Element && target.closest('.profile-scrim')) return
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (event.altKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
        event.preventDefault()
        onPage(event.code === 'ArrowLeft' ? -1 : 1)
        return
      }
      if (typing) return
      if (themesOpen || profilesOpen) {
        if (event.code === 'Escape') {
          event.preventDefault()
          setThemesOpen(false)
          setProfilesOpen(false)
        }
        return
      }
      if (event.code === 'Escape') {
        if (openedId) {
          event.preventDefault()
          setOpenedId(null)
          setSheet((current) => (current === 'task' ? 'day' : current))
          return
        }
        if (!split && sheet) {
          event.preventDefault()
          setSheet(null)
        }
        return
      }
      if (event.altKey && (event.code === 'ArrowUp' || event.code === 'ArrowDown')) {
        event.preventDefault()
        if (!tasks) return
        const movingSteps = Boolean(openedId && subPicked)
        const open = movingSteps
          ? tasks.filter((task) => task.parentId === openedId && !task.done)
          : tasks.filter((task) => task.day === selected && !task.done && !task.parentId)
        const currentId = movingSteps ? subPicked : picked
        const index = open.findIndex((task) => task.id === currentId)
        if (index < 0) return
        const next = event.code === 'ArrowUp' ? index - 1 : index + 1
        if (next < 0 || next >= open.length) return
        const ids = open.map((task) => task.id)
        const [moved] = ids.splice(index, 1)
        ids.splice(next, 0, moved)
        if (movingSteps && openedId) {
          setSubPicked(moved)
          onReorderSubtasks(openedId, ids)
        } else {
          setPicked(moved)
          onReorder(selected, ids)
        }
        return
      }
      if (event.altKey) return
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight' || event.code === 'ArrowUp' || event.code === 'ArrowDown') {
        event.preventDefault()
        const column = !split && zoom === 'week'
        const delta =
          event.code === 'ArrowLeft' ? -1
          : event.code === 'ArrowRight' ? 1
          : event.code === 'ArrowUp' ? (column ? -1 : -7)
          : column ? 1 : 7
        const next = addDays(selected, delta)
        onSelect(next)
        if (!days.includes(next)) onCursor(next)
        return
      }
      if (event.code === 'KeyN') {
        event.preventDefault()
        if (openedId) subRef.current?.focus()
        else addRef.current?.focus()
        return
      }
      if (!tasks) return
      const open = tasks.filter((task) => task.day === selected && !task.done && !task.parentId)
      const index = open.findIndex((task) => task.id === picked)
      const steps = openedId ? tasks.filter((task) => task.parentId === openedId && !task.done) : []
      const stepIndex = steps.findIndex((task) => task.id === subPicked)
      if (openedId && (event.code === 'KeyJ' || event.code === 'KeyK')) {
        event.preventDefault()
        if (steps.length === 0) return
        const direction = event.code === 'KeyJ' ? 1 : -1
        const next = stepIndex < 0 ? (direction === 1 ? 0 : steps.length - 1) : stepIndex + direction
        const item = steps[Math.max(0, Math.min(steps.length - 1, next))]
        if (item) setSubPicked(item.id)
        return
      }
      if (event.code === 'KeyJ' || event.code === 'KeyK') {
        event.preventDefault()
        if (open.length === 0) return
        const direction = event.code === 'KeyJ' ? 1 : -1
        const next = index < 0 ? (direction === 1 ? 0 : open.length - 1) : index + direction
        const item = open[Math.max(0, Math.min(open.length - 1, next))]
        if (item) setPicked(item.id)
        return
      }
      if (event.code === 'Enter' && !openedId && index >= 0) {
        event.preventDefault()
        const current = open[index]
        focusSub.current = true
        setOpenedId(current.id)
        setSheet('task')
        return
      }
      if (openedId && event.code === 'KeyX' && stepIndex >= 0) {
        event.preventDefault()
        const current = steps[stepIndex]
        const neighbor = steps[stepIndex + 1] ?? steps[stepIndex - 1]
        setSubPicked(neighbor?.id ?? null)
        onToggle(current.id, true)
        return
      }
      if (event.code === 'KeyX' && index >= 0) {
        event.preventDefault()
        const current = open[index]
        const neighbor = open[index + 1] ?? open[index - 1]
        setPicked(neighbor?.id ?? null)
        onToggle(current.id, true)
        return
      }
      if (event.code === 'KeyI' && index >= 0) {
        event.preventDefault()
        const current = open[index]
        onPriority(current.id, current.priority === 'important' ? 'normal' : 'important')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    tasks,
    picked,
    subPicked,
    openedId,
    sheet,
    split,
    selected,
    days,
    zoom,
    onSelect,
    onCursor,
    onPage,
    onReorder,
    onReorderSubtasks,
    onToggle,
    onPriority,
    themesOpen,
    profilesOpen,
  ])

  function pickTask(day: string, id: string) {
    setPicked(id)
    if (day !== selected) {
      keepPick.current = id
      onSelect(day)
    }
  }

  function blank(day: string) {
    setPicked(null)
    if (day !== selected) onSelect(day)
  }

  function openAdd(day: string) {
    if (split || sheet) {
      if (day !== selected) onSelect(day)
      addRef.current?.focus()
      return
    }
    wantFocus.current = true
    if (day !== selected) onSelect(day)
    else {
      wantFocus.current = false
      addRef.current?.focus()
    }
  }

  function openDay(day: string) {
    if (day !== selected) onSelect(day)
    if (!split) setSheet('day')
  }

  function openTask(day: string, id: string) {
    focusSub.current = window.matchMedia('(pointer: fine)').matches
    setOpenedId(id)
    setSheet('task')
    setPicked(id)
    if (day !== selected) {
      keepPick.current = id
      onSelect(day)
    }
  }

  function closeTask() {
    setOpenedId(null)
    setSheet((current) => (current === 'task' ? 'day' : current))
  }

  function onDragEnd(event: DragEndEvent) {
    if (!tasks || !event.over || event.active.id === event.over.id) return
    const activeId = String(event.active.id)
    const overId = String(event.over.id)
    const active = tasks.find((task) => task.id === activeId)
    const over = tasks.find((task) => task.id === overId)
    if (!active || !over || active.parentId !== over.parentId || active.done || over.done) return
    if (!active.parentId && active.day !== over.day) return
    const ids = sortTasks(
      tasks.filter(
        (task) => !task.done && task.parentId === active.parentId && (active.parentId !== null || task.day === active.day),
      ),
    ).map((task) => task.id)
    const oldIndex = ids.indexOf(activeId)
    const newIndex = ids.indexOf(overId)
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(ids, oldIndex, newIndex)
    if (active.parentId) onReorderSubtasks(active.parentId, next)
    else onReorder(active.day, next)
  }

  async function submit(day: string, event: FormEvent) {
    event.preventDefault()
    const draft = (drafts[day] ?? '').trim()
    if (!draft) return
    setDrafts((current) => ({ ...current, [day]: '' }))
    const ok = await onAdd(day, draft)
    if (!ok) {
      setDrafts((current) => ({ ...current, [day]: current[day] ? current[day] : draft }))
    }
  }

  function commitDockEdit() {
    if (skipDock.current) {
      skipDock.current = false
      return
    }
    if (!pickedTask || dockEdit === null) return
    const next = dockEdit.trim()
    setDockEdit(null)
    if (!next || next === pickedTask.title) return
    onRename(pickedTask.id, next)
  }

  const addLabel = `Новое дело, ${weekdayOf(selected)} ${dateLineOf(selected)}`

  function chooseTheme(id: ThemeId) {
    onTheme(id)
  }

  function onBoardPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (split || event.pointerType === 'mouse') return
    const target = event.target
    if (target instanceof Element && target.closest('input, textarea, select')) return
    dropSwipe.current?.()
    const startX = event.clientX
    const startY = event.clientY
    const pointer = event.pointerId
    function end(ev: PointerEvent) {
      if (ev.pointerId !== pointer) return
      clear()
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.25) return
      ignoreClick.current = true
      window.setTimeout(() => {
        ignoreClick.current = false
      }, 400)
      onPage(dx < 0 ? 1 : -1)
    }
    function clear() {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (dropSwipe.current === clear) dropSwipe.current = null
    }
    dropSwipe.current = clear
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const touch = !split
  const phoneMonth = touch && zoom === 'month'

  return (
    <main
      className={zoom === 'month' ? (touch ? 'cal is-month is-touch' : 'cal is-month') : touch ? 'cal is-week is-touch' : 'cal is-week'}
      data-theme={theme === 'paper' ? undefined : theme}
      data-tone={themeTone(theme)}
    >
      <div className={profilesOpen ? 'cal-bar is-float' : 'cal-bar'}>
        <div className="cal-shift">
          <button type="button" className="cal-arrow" aria-label={zoom === 'month' ? 'Предыдущий месяц' : 'Предыдущая неделя'} onClick={() => onPage(-1)}>
            ←
          </button>
          <h1 className="cal-heading" id="cal-title">
            {title}
          </h1>
          <button type="button" className="cal-arrow" aria-label={zoom === 'month' ? 'Следующий месяц' : 'Следующая неделя'} onClick={() => onPage(1)}>
            →
          </button>
        </div>
        <div className="cal-tools">
          {selected !== today ? (
            <button type="button" className="text" onClick={onToday}>
              сегодня
            </button>
          ) : null}
          <div className="zoom" role="group" aria-label="Масштаб">
            <button type="button" aria-pressed={zoom === 'month'} onClick={() => onZoom('month')}>
              месяц
            </button>
            <button type="button" aria-pressed={zoom === 'week'} onClick={() => onZoom('week')}>
              неделя
            </button>
          </div>
          <button
            ref={themeBtn}
            type="button"
            className="text theme-toggle"
            aria-expanded={themesOpen}
            aria-controls="theme-pop"
            onClick={() => {
              setThemesOpen((open) => !open)
              setProfilesOpen(false)
            }}
          >
            <span className="theme-dot" data-id={theme} aria-hidden="true" />
            вид
          </button>
          {selectedOpen.length > 0 ? (
            <button type="button" className="carry" onClick={onCarry}>
              Хвост на {relativeLabel(addDays(selected, 1), today) ?? shortDateOf(addDays(selected, 1))}
            </button>
          ) : null}
          <button type="button" className="text" onClick={onArchive}>
            сделанное
          </button>
          {authRequired ? (
            <button type="button" className="text" onClick={onLogout}>
              выйти
            </button>
          ) : null}
        </div>
        <div className="profile-slot">
          <button
            ref={profileBtn}
            type="button"
            className="profile-toggle"
            aria-label={`Профиль ${profileName}`}
            title={profileName}
            aria-expanded={profilesOpen}
            aria-controls="profile-pop"
            onClick={() => {
              setProfilesOpen((open) => !open)
              setThemesOpen(false)
            }}
          >
            <span className="profile-mark" aria-hidden="true">
              {profileLetter(profileName)}
            </span>
          </button>
          {profilesOpen ? (
            <div id="profile-pop" className="profile-pop" ref={profilePop} role="dialog" aria-label="Профили">
              <ProfileMenu
                profiles={profiles}
                currentId={profileId}
                onSwitch={onSwitchProfile}
                onAdd={onAddProfile}
                onRename={onRenameProfile}
                onDelete={onDeleteProfile}
                onClose={() => setProfilesOpen(false)}
              />
            </div>
          ) : null}
        </div>
      </div>
      {themesOpen ? (
        <div className="theme-pop" id="theme-pop" ref={themePop} role="listbox" aria-label="Оформление">
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              className="theme-card"
              aria-selected={item.id === theme}
              onClick={() => chooseTheme(item.id)}
            >
              <span className={item.id === 'paper' ? 'theme-shot is-paper' : 'theme-shot'} data-id={item.id} />
              <span className="theme-name">{item.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="note">{error}</p> : note ? <p className="note">{note}</p> : null}
      {tasks === null && error ? (
        <button type="button" className="text" onClick={onRetry}>
          ещё раз
        </button>
      ) : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div className={showTask ? 'cal-split has-task' : 'cal-split'}>
        <div
          ref={boardRef}
          className="cal-board"
          role="grid"
          aria-labelledby="cal-title"
          aria-busy={tasks === null}
          style={{ '--weeks': weeks.length } as CSSProperties}
          onPointerDown={onBoardPointerDown}
        >
          <div className="cal-dows" role="row">
            {WEEKDAYS.map((name, index) => (
              <div key={name} className={index >= 5 ? 'cal-dow is-weekend' : 'cal-dow'} role="columnheader">
                {name}
              </div>
            ))}
          </div>
          <div className="cal-weeks">
            {weeks.map((week) => (
              <div className="cal-week" role="row" key={week[0]}>
                {week.map((day, index) => {
                  const mine = byDay.get(day) ?? []
                  const open = mine.filter((task) => !task.done)
                  const done = mine.filter((task) => task.done)
                  const outside = zoom === 'month' && day.slice(0, 7) !== cursor.slice(0, 7)
                  const names = ['cal-day']
                  if (index >= 5) names.push('is-weekend')
                  if (outside) names.push('is-outside')
                  if (day === today) names.push('is-today')
                  if (day === selected) names.push('is-selected')
                  return (
                    <div
                      key={day}
                      className={names.join(' ')}
                      role="gridcell"
                      data-day={day}
                      aria-selected={day === selected}
                      aria-current={day === today ? 'date' : undefined}
                      onPointerDown={(event) => onCellPointerDown(event, day)}
                      onClick={(event) => onCellClick(event, day)}
                    >
                      <div className="cal-head">
                        <button
                          type="button"
                          className="cal-num"
                          onClick={(event) => {
                            event.stopPropagation()
                            if (split) openAdd(day)
                            else if (phoneMonth) openDay(day)
                            else blank(day)
                          }}
                          aria-label={
                            open.length > 0
                              ? `${Number(day.slice(8, 10))}, ${weekdayOf(day)}, дел ${open.length}`
                              : `${Number(day.slice(8, 10))}, ${weekdayOf(day)}`
                          }
                        >
                          {Number(day.slice(8, 10))}
                        </button>
                        {touch && zoom === 'week' ? (
                          <span className="cal-wname">
                            {weekdayOf(day)}
                            {day === today ? <span className="cal-rel">сегодня</span> : null}
                          </span>
                        ) : null}
                        {touch && !phoneMonth && !docked && sheet === null && day === selected ? (
                          <button type="button" className="cal-open" onClick={() => openDay(day)}>
                            Открыть
                          </button>
                        ) : null}
                      </div>
                      {phoneMonth ? (
                        open.length > 0 || done.length > 0 ? (
                          <div className="cal-pips" aria-hidden="true">
                            {(open.length > 0 ? open : done).slice(0, 3).map((task) => (
                              <i
                                key={task.id}
                                className={
                                  task.done ? 'is-done' : task.priority === 'important' ? 'is-hot' : undefined
                                }
                              />
                            ))}
                            {open.length > 3 ? <span>+{open.length - 3}</span> : null}
                          </div>
                        ) : null
                      ) : (
                      <>
                      <div className="cal-scroll">
                        {open.length > 0 ? (
                          dragOnCalendar ? (
                            <SortableContext items={open.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                              <ul className="cal-tasks">
                                {open.map((task) => (
                                  <OpenChip key={task.id} {...chipProps(day, task)} showSteps={zoom === 'week'} />
                                ))}
                              </ul>
                            </SortableContext>
                          ) : (
                            <ul className="cal-tasks">
                              {open.map((task) => (
                                <TaskLine
                                  key={task.id}
                                  {...chipProps(day, task)}
                                  showSteps={zoom === 'week'}
                                  leading={<span className="chip-handle" />}
                                />
                              ))}
                            </ul>
                          )
                        ) : null}
                        {done.length > 0 ? (
                          <ul className="cal-tasks cal-done">
                            {done.map((task) => (
                              <TaskLine
                                key={task.id}
                                {...chipProps(day, task)}
                                showSteps={zoom === 'week'}
                                leading={<span className="chip-handle" />}
                              />
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      {!docked && !split && !sheet && day === selected ? (
                        <Composer
                          className="cal-inline"
                          value={drafts[day] ?? ''}
                          placeholder="дело"
                          label={addLabel}
                          submitLabel="ок"
                          inputRef={addRef}
                          onChange={(value) => setDrafts((current) => ({ ...current, [day]: value }))}
                          onSubmit={(event) => void submit(day, event)}
                        />
                      ) : null}
                      </>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        {showDay ? (
          <DayPane
            day={selected}
            today={today}
            tasks={selectedTasks}
            openedId={openedTask?.id ?? null}
            covered={!split && sheet === 'task'}
            sheet={!split}
            draft={drafts[selected] ?? ''}
            inputRef={addRef}
            stepsOf={stepsOf}
            onClose={() => setSheet(null)}
            onDraft={(value) => setDrafts((current) => ({ ...current, [selected]: value }))}
            onSubmit={(event) => void submit(selected, event)}
            onOpenTask={(id) => openTask(selected, id)}
            onToggle={onToggle}
            onPriority={onPriority}
            onRename={onRename}
            onDelete={(id) => {
              if (picked === id) setPicked(null)
              if (openedId === id) closeTask()
              onDelete(id)
            }}
          />
        ) : null}
        {showTask && openedTask ? (
          <TaskPane
            task={openedTask}
            day={openedTask.day}
            today={today}
            steps={stepsOf(openedTask.id)}
            pickedId={subPicked}
            sheet={!split}
            closeLabel={roomy ? 'закрыть' : 'к дню'}
            inputRef={subRef}
            onClose={closeTask}
            onToggle={(done) => onToggle(openedTask.id, done)}
            onPriority={() => onPriority(openedTask.id, openedTask.priority === 'important' ? 'normal' : 'important')}
            onRename={(value) => onRename(openedTask.id, value)}
            onDelete={() => {
              const id = openedTask.id
              closeTask()
              onDelete(id)
            }}
            onToggleStep={onToggle}
            onRenameStep={onRename}
            onDeleteStep={(id) => {
              if (subPicked === id) setSubPicked(null)
              onDelete(id)
            }}
            onAdd={(value) => onAddSubtask(openedTask.id, value)}
          />
        ) : null}
        </div>
      </DndContext>
      {docked ? (
        <form className={pickedTask ? 'cal-dock has-task' : 'cal-dock'} onSubmit={(event) => void submit(selected, event)}>
          <button type="button" className="cal-open" onClick={() => openDay(selected)}>
            Открыть {place}
          </button>
          {pickedTask ? (
            <div className="cal-dock-task">
              {dockEdit !== null ? (
                <input
                  className="chip-input"
                  value={dockEdit}
                  onChange={(event) => setDockEdit(event.target.value)}
                  onBlur={commitDockEdit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                    if (event.key === 'Escape') {
                      skipDock.current = true
                      setDockEdit(null)
                    }
                  }}
                  aria-label="Название"
                  autoFocus
                  maxLength={500}
                />
              ) : (
                <p className="cal-dock-title">{pickedTask.title}</p>
              )}
              <div className="cal-dock-actions">
                <button type="button" onClick={() => onToggle(pickedTask.id, !pickedTask.done)}>
                  {pickedTask.done ? 'вернуть' : 'готово'}
                </button>
                <button
                  type="button"
                  className={pickedTask.priority === 'important' ? 'is-on' : undefined}
                  onClick={() =>
                    onPriority(pickedTask.id, pickedTask.priority === 'important' ? 'normal' : 'important')
                  }
                >
                  важно
                </button>
                <button type="button" onClick={() => openTask(pickedTask.day, pickedTask.id)}>
                  шаги
                </button>
                <button type="button" onClick={() => setDockEdit(pickedTask.title)}>
                  править
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(null)
                    onDelete(pickedTask.id)
                  }}
                >
                  убрать
                </button>
              </div>
            </div>
          ) : null}
          <div className="cal-dock-row">
            <input
              ref={addRef}
              value={drafts[selected] ?? ''}
              onChange={(event) => setDrafts((current) => ({ ...current, [selected]: event.target.value }))}
              placeholder={`Новое дело · ${place}`}
              aria-label={addLabel}
              enterKeyHint="done"
              autoComplete="off"
              autoCapitalize="sentences"
              maxLength={500}
              onKeyDown={(event) => {
                if (event.key === 'Escape') event.currentTarget.blur()
              }}
            />
            <button type="submit" disabled={(drafts[selected] ?? '').trim() === ''}>
              Добавить
            </button>
          </div>
        </form>
      ) : null}
      <p className="keys">
        {`n новое · enter шаги · esc закрыть · стрелки день · j k ход · x готово · i важно · alt ↑↓ порядок · alt ← → ${zoom === 'month' ? 'месяц' : 'неделя'}`}
      </p>
    </main>
  )

  function onCellPointerDown(event: ReactPointerEvent<HTMLDivElement>, day: string) {
    if (event.pointerType !== 'mouse') return
    const target = event.target
    if (target instanceof Element && target.closest('[data-task]')) return
    blank(day)
  }

  function onCellClick(event: ReactMouseEvent<HTMLDivElement>, day: string) {
    if (ignoreClick.current) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('button, input, label, a, textarea, [data-task]')) return
    if (split) openAdd(day)
    else if (phoneMonth) openDay(day)
    else blank(day)
  }

  function chipProps(day: string, task: Task) {
    return {
      task,
      picked: task.id === picked,
      opened: task.id === openedId,
      hint: stepMark(stepsOf(task.id)) ?? undefined,
      canEdit: false,
      onPick: () => pickTask(day, task.id),
      onOpen: () => openTask(day, task.id),
      onToggle: (done: boolean) => onToggle(task.id, done),
      onPriority: () => onPriority(task.id, task.priority === 'important' ? 'normal' : 'important'),
      onRename: (value: string) => onRename(task.id, value),
      onDelete: () => {
        if (picked === task.id) setPicked(null)
        if (openedId === task.id) closeTask()
        onDelete(task.id)
      },
    }
  }
}

function Composer({
  className,
  value,
  placeholder,
  label,
  submitLabel,
  inputRef,
  onChange,
  onSubmit,
}: {
  className: string
  value: string
  placeholder: string
  label: string
  submitLabel: string
  inputRef?: { current: HTMLInputElement | null }
  onChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form className={className} onSubmit={onSubmit}>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        enterKeyHint="done"
        autoComplete="off"
        autoCapitalize="sentences"
        maxLength={500}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
      />
      <button type="submit" className="cal-add" disabled={value.trim() === ''}>
        {submitLabel}
      </button>
    </form>
  )
}

function OpenChip(props: LineProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.task.id })
  return (
    <TaskLine
      {...props}
      setNodeRef={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : undefined,
      }}
      leading={
        <button type="button" className="chip-handle" aria-label="Перетащить" {...attributes} {...listeners}>
          ⋮⋮
        </button>
      }
    />
  )
}

type LineProps = {
  task: Task
  picked: boolean
  opened?: boolean
  hint?: string
  canEdit: boolean
  showSteps?: boolean
  onPick: () => void
  onOpen?: () => void
  onToggle: (done: boolean) => void
  onPriority: () => void
  onRename: (title: string) => void
  onDelete: () => void
}

function TaskLine({
  task,
  picked,
  opened,
  hint,
  canEdit,
  showSteps = false,
  onPick,
  onOpen,
  onToggle,
  onPriority,
  onRename,
  onDelete,
  leading,
  setNodeRef,
  style,
}: LineProps & {
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

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    }
    if (event.key === 'Escape') {
      skipSave.current = true
      setValue(task.title)
      event.currentTarget.blur()
    }
  }

  const names = ['chip']
  if (task.priority === 'important') names.push('is-important')
  if (task.done) names.push('is-done')
  if (picked) names.push('is-picked')
  if (opened) names.push('is-open')

  return (
    <li
      ref={setNodeRef}
      className={names.join(' ')}
      data-task=""
      data-id={task.id}
      style={style}
      onPointerDown={(event) => {
        if (event.pointerType !== 'mouse') return
        const target = event.target
        if (target instanceof Element && target.closest('input, button, a, label, textarea')) return
        onPick()
      }}
      onClick={(event) => {
        const target = event.target
        if (target instanceof Element && target.closest('input, button, a, label, textarea')) return
        onPick()
      }}
    >
      {leading}
      <label className="chip-check">
        <input
          type="checkbox"
          checked={task.done}
          onChange={(event) => {
            onPick()
            onToggle(event.target.checked)
          }}
          aria-label={task.done ? 'Вернуть в список' : 'Сделано'}
        />
        <span className="chip-box" aria-hidden="true" />
      </label>
      {task.priority === 'important' ? <span className="chip-mark" aria-hidden="true" /> : null}
      {editing ? (
        <input
          className="chip-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          aria-label="Название"
          autoFocus
          maxLength={500}
        />
      ) : (
        <button
          type="button"
          className="chip-title"
          title={hint ? `${task.title}, ${hint}` : task.title}
          onClick={() => {
            if (picked && canEdit) setEditing(true)
            else onPick()
          }}
        >
          {task.title}
        </button>
      )}
      {hint && onOpen ? (
        <button type="button" className="chip-subs" onClick={onOpen} aria-label={`Шаги, ${hint}`}>
          {hint}
        </button>
      ) : showSteps && picked && onOpen ? (
        <button type="button" className="chip-open" onClick={onOpen}>
          шаги
        </button>
      ) : null}
      <button
        type="button"
        className={task.priority === 'important' ? 'chip-pri is-on' : 'chip-pri'}
        aria-pressed={task.priority === 'important'}
        aria-label={task.priority === 'important' ? 'Снять важность' : 'Отметить важным'}
        onClick={onPriority}
      >
        важно
      </button>
      <button type="button" className="chip-x" aria-label="Убрать" onClick={onDelete}>
        ×
      </button>
    </li>
  )
}
