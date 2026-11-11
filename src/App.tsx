import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addDays,
  addMonths,
  monthGrid,
  monthStart,
  relativeLabel,
  shortDateOf,
  todayKey,
  weekDays,
} from '../shared/dates.ts'
import { carriedNote } from '../shared/text.ts'
import type { ArchiveGroup, CarryPayload, DayPayload, Priority, SmokeKind, SmokePayload, Task } from '../shared/types.ts'
import { api, AuthError } from './api.ts'
import { ArchiveScreen } from './ArchiveScreen.tsx'
import { CalendarScreen } from './CalendarScreen.tsx'
import { LoginScreen } from './LoginScreen.tsx'
import { SmokeWindow } from './SmokeWindow.tsx'

function where(target: string, today: string): string {
  return relativeLabel(target, today) ?? shortDateOf(target)
}

export function App() {
  const [session, setSession] = useState<{ required: boolean; ok: boolean } | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const onUnauthorized = useCallback(() => {
    setSession((current) => ({ required: current?.required ?? true, ok: false }))
  }, [])

  const loadSession = useCallback(() => {
    setSessionError(null)
    api
      .session()
      .then(setSession)
      .catch(() => setSessionError('Не открылось.'))
  }, [])

  useEffect(() => {
    loadSession()
  }, [loadSession])

  if (sessionError) {
    return (
      <main className="page">
        <p className="note">{sessionError}</p>
        <button type="button" className="carry" onClick={loadSession}>
          Ещё раз
        </button>
      </main>
    )
  }
  if (!session) return <main className="page"><p className="empty">Открываю</p></main>
  if (session.required && !session.ok) return <LoginScreen onSuccess={() => setSession({ required: true, ok: true })} />
  return <Planner authRequired={session.required} onUnauthorized={onUnauthorized} />
}

function Planner({
  authRequired,
  onUnauthorized,
}: {
  authRequired: boolean
  onUnauthorized: () => void
}) {
  const opened = todayKey()
  const [today, setToday] = useState(opened)
  const [cursor, setCursor] = useState(opened)
  const [selected, setSelected] = useState(opened)
  const [zoom, setZoom] = useState<'month' | 'week'>('month')
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [view, setView] = useState<'calendar' | 'archive'>('calendar')
  const [groups, setGroups] = useState<ArchiveGroup[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [smoke, setSmoke] = useState<SmokePayload | null>(null)
  const [smokeError, setSmokeError] = useState<string | null>(null)
  const [smokePending, setSmokePending] = useState(false)
  const alive = useRef(true)
  const loadSeq = useRef(0)
  const writeEpoch = useRef(0)
  const writesInFlight = useRef(0)
  const pendingReload = useRef(false)
  const loadedRef = useRef<{ from: string; to: string } | null>(null)
  const smokeSeq = useRef(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const days = useMemo(
    () => (zoom === 'month' ? monthGrid(cursor) : weekDays(cursor)),
    [zoom, cursor],
  )
  const from = days[0]
  const to = days[days.length - 1]
  const visibleRef = useRef({ from, to })
  visibleRef.current = { from, to }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  function report(caught: unknown) {
    if (!alive.current) return
    if (caught instanceof AuthError) onUnauthorized()
    else setError(caught instanceof Error ? caught.message : 'Не сохранилось.')
  }

  function rangeToLoad(): { from: string; to: string } {
    const have = loadedRef.current
    const vis = visibleRef.current
    if (have && vis.from >= have.from && vis.to <= have.to) return have
    return vis
  }

  const loadSpanRef = useRef<(spanFrom: string, spanTo: string) => Promise<void>>(async () => {})
  loadSpanRef.current = async (spanFrom: string, spanTo: string) => {
    const seq = ++loadSeq.current
    const epoch = writeEpoch.current
    try {
      const data = await api.span(spanFrom, spanTo)
      if (!alive.current || loadSeq.current !== seq) return
      if (writeEpoch.current !== epoch) {
        if (writesInFlight.current === 0) void loadSpanRef.current(spanFrom, spanTo)
        else pendingReload.current = true
        return
      }
      loadedRef.current = { from: data.from, to: data.to }
      setToday(data.today)
      setTasks(data.tasks)
    } catch (caught) {
      if (!alive.current || loadSeq.current !== seq) return
      report(caught)
    }
  }

  useEffect(() => {
    const have = loadedRef.current
    if (have && from >= have.from && to <= have.to) return
    void loadSpanRef.current(from, to)
  }, [from, to])

  useEffect(() => {
    const day = selected
    const seq = ++smokeSeq.current
    api.smoke(day).then(
      (data) => {
        if (!alive.current || smokeSeq.current !== seq || selectedRef.current !== day) return
        setSmoke(data)
        setSmokeError(null)
      },
      (caught: unknown) => {
        if (!alive.current || smokeSeq.current !== seq) return
        if (caught instanceof AuthError) onUnauthorized()
        else setSmokeError(caught instanceof Error ? caught.message : 'Не сохранилось.')
      },
    )
  }, [selected, onUnauthorized])

  function applySmoke(seq: number, day: string, data: SmokePayload) {
    if (!alive.current || smokeSeq.current !== seq || selectedRef.current !== day) return
    setSmoke(data)
    setSmokeError(null)
  }

  async function runSmoke(day: string, run: () => Promise<SmokePayload>) {
    const seq = ++smokeSeq.current
    setSmokePending(true)
    setSmokeError(null)
    try {
      applySmoke(seq, day, await run())
    } catch (caught) {
      if (!alive.current || smokeSeq.current !== seq) return
      if (caught instanceof AuthError) onUnauthorized()
      else setSmokeError(caught instanceof Error ? caught.message : 'Не сохранилось.')
    } finally {
      if (alive.current && smokeSeq.current === seq) setSmokePending(false)
    }
  }

  function mergeDay(data: DayPayload) {
    setToday(data.today)
    setTasks((current) => [...(current ?? []).filter((task) => task.day !== data.day), ...data.tasks])
  }

  function absorbCarry(data: CarryPayload) {
    setToday(data.today)
    setNote(carriedNote(data.moved, where(data.to, data.today)))
    setTasks((current) => {
      if (!current) return data.tasks
      const movingParents = current.filter((task) => task.day === data.day && !task.done && !task.parentId)
      const movingIds = new Set(movingParents.map((task) => task.id))
      let nextPos = current.reduce(
        (max, task) => (task.day === data.to && !task.done && !task.parentId ? Math.max(max, task.position) : max),
        -1,
      )
      const movedParents = movingParents.map((task) => ({ ...task, day: data.to, position: ++nextPos }))
      const movedChildren = current
        .filter((task) => task.parentId !== null && movingIds.has(task.parentId))
        .map((task) => ({ ...task, day: data.to }))
      const kept = current.filter((task) => {
        if (task.parentId !== null && movingIds.has(task.parentId)) return false
        return task.parentId !== null || task.day !== data.day || task.done
      })
      return [...kept, ...movedParents, ...movedChildren]
    })
  }

  function reloadIfNeeded() {
    writesInFlight.current -= 1
    if (!alive.current || writesInFlight.current > 0 || !pendingReload.current) return
    pendingReload.current = false
    const range = rangeToLoad()
    void loadSpanRef.current(range.from, range.to)
  }

  async function commit<T>(run: () => Promise<T>, apply: (value: T) => void, forceReload = false): Promise<boolean> {
    setError(null)
    writesInFlight.current += 1
    writeEpoch.current += 1
    if (forceReload) pendingReload.current = true
    try {
      apply(await run())
      return true
    } catch (caught) {
      report(caught)
      pendingReload.current = true
      return false
    } finally {
      reloadIfNeeded()
    }
  }

  function choose(next: string) {
    setSelected(next)
    setNote(null)
  }

  function page(delta: number) {
    setNote(null)
    if (zoom === 'week') {
      const next = addDays(selected, delta * 7)
      setCursor(next)
      setSelected(next)
      return
    }
    const nextCursor = addMonths(monthStart(cursor), delta)
    const desired = addMonths(selected, delta)
    const grid = monthGrid(nextCursor)
    setCursor(nextCursor)
    setSelected(grid.includes(desired) ? desired : nextCursor)
  }

  function changeZoom(next: 'month' | 'week') {
    setNote(null)
    if (next === 'week') {
      setZoom('week')
      setCursor(selected)
      return
    }
    setZoom('month')
    setCursor((current) => (monthGrid(current).includes(selected) ? current : selected))
  }

  async function openArchive() {
    setView('archive')
    setGroups(null)
    setError(null)
    try {
      const data = await api.archive()
      if (!alive.current) return
      setToday(data.today)
      setGroups(data.groups)
    } catch (caught) {
      report(caught)
    }
  }

  async function onLogout() {
    try {
      await api.logout()
    } catch {
      // Выходим даже если сессия уже погасла.
    }
    onUnauthorized()
  }

  if (view === 'archive') {
    return (
      <ArchiveScreen
        groups={groups}
        error={error}
        authRequired={authRequired}
        onOpenDay={(next) => {
          setView('calendar')
          setZoom('month')
          setCursor(next)
          setSelected(next)
          setNote(null)
          setError(null)
        }}
        onBack={() => {
          setView('calendar')
          setError(null)
        }}
        onLogout={() => void onLogout()}
      />
    )
  }

  return (
    <>
    <CalendarScreen
      today={today}
      cursor={cursor}
      zoom={zoom}
      selected={selected}
      days={days}
      tasks={tasks}
      note={note}
      error={error}
      authRequired={authRequired}
      onLogout={() => void onLogout()}
      onSelect={choose}
      onCursor={(next) => {
        setCursor(next)
        setNote(null)
      }}
      onPage={page}
      onZoom={changeZoom}
      onToday={() => {
        setCursor(today)
        setSelected(today)
        setNote(null)
      }}
      onArchive={() => void openArchive()}
      onRetry={() => {
        setError(null)
        void loadSpanRef.current(from, to)
      }}
      onAdd={(day, title) => commit(() => api.add(day, title), mergeDay)}
      onToggle={(id, done) => void commit(() => api.update(id, { done }), mergeDay)}
      onPriority={(id, priority: Priority) => void commit(() => api.update(id, { priority }), mergeDay)}
      onRename={(id, title) => void commit(() => api.update(id, { title }), mergeDay)}
      onDelete={(id) => void commit(() => api.remove(id), mergeDay)}
      onReorder={(day, ids) => {
        setTasks((current) => reorderTasks(current, day, ids))
        return void commit(() => api.reorder(day, ids), mergeDay)
      }}
      onAddSubtask={(parentId, title) => commit(() => api.addSubtask(parentId, title), mergeDay)}
      onReorderSubtasks={(parentId, ids) => {
        setTasks((current) => reorderSubtasks(current, parentId, ids))
        return void commit(() => api.reorderSubtasks(parentId, ids), mergeDay)
      }}
      onCarry={() => {
        const day = selected
        void commit(() => api.carry(day), absorbCarry, true)
      }}
    />
    <SmokeWindow
      day={selected}
      today={smoke?.today ?? today}
      smoke={smoke}
      error={smokeError}
      pending={smokePending}
      onRetry={() => {
        const day = selected
        const seq = ++smokeSeq.current
        setSmokeError(null)
        api.smoke(day).then(
          (data) => applySmoke(seq, day, data),
          (caught: unknown) => {
            if (!alive.current || smokeSeq.current !== seq) return
            if (caught instanceof AuthError) onUnauthorized()
            else setSmokeError(caught instanceof Error ? caught.message : 'Не сохранилось.')
          },
        )
      }}
      onStock={(patch) => {
        const day = selected
        void runSmoke(day, () => api.smokeStock(day, patch))
      }}
      onBreak={(kind: SmokeKind) => {
        const day = selected
        void runSmoke(day, () => api.smokeBreak(day, kind))
      }}
      onUndo={(id) => {
        const day = selected
        void runSmoke(day, () => api.smokeUndo(day, id))
      }}
    />
    </>
  )
}

function reorderTasks(current: Task[] | null, day: string, ids: string[]): Task[] | null {
  if (!current) return current
  const mine = current.filter((task) => task.day === day && !task.parentId)
  const open = mine.filter((task) => !task.done)
  const done = mine.filter((task) => task.done)
  const byId = new Map(open.map((task) => [task.id, task]))
  const nextOpen = ids.flatMap((id, position) => {
    const task = byId.get(id)
    return task ? [{ ...task, position }] : []
  })
  if (nextOpen.length !== open.length) return current
  return [...current.filter((task) => task.day !== day || task.parentId), ...nextOpen, ...done]
}

function reorderSubtasks(current: Task[] | null, parentId: string, ids: string[]): Task[] | null {
  if (!current) return current
  const open = current.filter((task) => task.parentId === parentId && !task.done)
  const done = current.filter((task) => task.parentId === parentId && task.done)
  const byId = new Map(open.map((task) => [task.id, task]))
  const nextOpen = ids.flatMap((id, position) => {
    const task = byId.get(id)
    return task ? [{ ...task, position }] : []
  })
  if (nextOpen.length !== open.length) return current
  return [...current.filter((task) => task.parentId !== parentId), ...nextOpen, ...done]
}
