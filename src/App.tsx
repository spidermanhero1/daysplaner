import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import type {
  ArchiveGroup,
  CarryPayload,
  DayPayload,
  OrderStatus,
  Priority,
  Profile,
  ProfilesPayload,
  ShoppingPayload,
  SmokeKind,
  SmokePayload,
  Task,
  WalletPayload,
} from '../shared/types.ts'
import { api, AuthError } from './api.ts'
import { applyTheme, clearTheme, forgetTheme, peekTheme, THEMES, type ThemeId } from './themes.ts'
import { ArchiveScreen } from './ArchiveScreen.tsx'
import { CalendarScreen } from './CalendarScreen.tsx'
import { LoginScreen } from './LoginScreen.tsx'
import { Float } from './float.tsx'
import { ShopWindow } from './ShopWindow.tsx'
import { SmokeWindow } from './SmokeWindow.tsx'
import { WalletWindow } from './WalletWindow.tsx'

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
      .catch((error: unknown) => {
        setSessionError(error instanceof Error && error.message ? error.message : 'Не открылось.')
      })
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
  const [shopping, setShopping] = useState<ShoppingPayload | null>(null)
  const [shoppingError, setShoppingError] = useState<string | null>(null)
  const [shoppingPending, setShoppingPending] = useState(false)
  const [wallet, setWallet] = useState<WalletPayload | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [walletPending, setWalletPending] = useState(false)
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const alive = useRef(true)
  const profileEpoch = useRef(0)
  const profileRef = useRef<string | null>(null)
  const loadSeq = useRef(0)
  const writeEpoch = useRef(0)
  const writesInFlight = useRef(0)
  const pendingReload = useRef(false)
  const loadedRef = useRef<{ from: string; to: string; profile: string } | null>(null)
  const smokeSeq = useRef(0)
  const shoppingSeq = useRef(0)
  const walletSeq = useRef(0)
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

  function applyProfiles(data: ProfilesPayload) {
    if (profileRef.current !== data.currentId) {
      profileEpoch.current += 1
      writeEpoch.current += 1
      smokeSeq.current += 1
      shoppingSeq.current += 1
      walletSeq.current += 1
      loadSeq.current += 1
      loadedRef.current = null
      writesInFlight.current = 0
      pendingReload.current = false
      setTasks(null)
      setSmoke(null)
      setShopping(null)
      setWallet(null)
      setGroups(null)
      setNote(null)
      setError(null)
      setSmokeError(null)
      setShoppingError(null)
      setWalletError(null)
    }
    profileRef.current = data.currentId
    setProfiles(data.profiles)
    setProfileId(data.currentId)
  }

  function rangeToLoad(): { from: string; to: string } {
    const have = loadedRef.current
    const vis = visibleRef.current
    if (have && have.profile === profileRef.current && vis.from >= have.from && vis.to <= have.to) return have
    return vis
  }

  const loadSpanRef = useRef<(spanFrom: string, spanTo: string) => Promise<void>>(async () => {})
  loadSpanRef.current = async (spanFrom: string, spanTo: string) => {
    const profile = profileRef.current
    if (!profile) return
    const seq = ++loadSeq.current
    const epoch = writeEpoch.current
    const stamp = profileEpoch.current
    try {
      const data = await api.span(spanFrom, spanTo)
      if (!alive.current || loadSeq.current !== seq || profileEpoch.current !== stamp) return
      if (profileRef.current !== profile) return
      if (writeEpoch.current !== epoch) {
        if (writesInFlight.current === 0) void loadSpanRef.current(spanFrom, spanTo)
        else pendingReload.current = true
        return
      }
      loadedRef.current = { from: data.from, to: data.to, profile }
      setToday(data.today)
      setTasks(data.tasks)
    } catch (caught) {
      if (!alive.current || loadSeq.current !== seq || profileEpoch.current !== stamp) return
      report(caught)
    }
  }

  useEffect(() => {
    if (!profileId) return
    const have = loadedRef.current
    if (have && have.profile === profileId && from >= have.from && to <= have.to) return
    void loadSpanRef.current(from, to)
  }, [from, to, profileId])

  useEffect(() => {
    if (!profileId) return
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
  }, [selected, onUnauthorized, profileId])

  const pullShopping = useCallback(() => {
    if (!profileId) return
    const seq = ++shoppingSeq.current
    setShoppingError(null)
    api.shopping().then(
      (data) => {
        if (!alive.current || shoppingSeq.current !== seq) return
        setShopping(data)
        setShoppingError(null)
      },
      (caught: unknown) => {
        if (!alive.current || shoppingSeq.current !== seq) return
        if (caught instanceof AuthError) onUnauthorized()
        else setShoppingError(caught instanceof Error ? caught.message : 'Не сохранилось.')
      },
    )
  }, [onUnauthorized, profileId])

  useEffect(() => {
    pullShopping()
  }, [pullShopping])

  const pullWallet = useCallback(() => {
    if (!profileId) return
    const seq = ++walletSeq.current
    setWalletError(null)
    api.wallet().then(
      (data) => {
        if (!alive.current || walletSeq.current !== seq) return
        setWallet(data)
        setWalletError(null)
      },
      (caught: unknown) => {
        if (!alive.current || walletSeq.current !== seq) return
        if (caught instanceof AuthError) onUnauthorized()
        else setWalletError(caught instanceof Error ? caught.message : 'Не сохранилось.')
      },
    )
  }, [onUnauthorized, profileId])

  useEffect(() => {
    pullWallet()
  }, [pullWallet])

  useEffect(() => {
    if (view !== 'archive' || !profileId) return
    const stamp = profileEpoch.current
    let cancel = false
    api.archive().then(
      (data) => {
        if (cancel || !alive.current || profileEpoch.current !== stamp) return
        setToday(data.today)
        setGroups(data.groups)
      },
      (caught: unknown) => {
        if (cancel || !alive.current || profileEpoch.current !== stamp) return
        report(caught)
      },
    )
    return () => {
      cancel = true
    }
  }, [view, profileId])

  function applySmoke(seq: number, day: string, data: SmokePayload) {
    if (!alive.current || smokeSeq.current !== seq || selectedRef.current !== day) return
    setSmoke(data)
    setSmokeError(null)
  }

  async function runSmoke(day: string, run: () => Promise<SmokePayload>) {
    const seq = ++smokeSeq.current
    const stamp = profileEpoch.current
    setSmokePending(true)
    setSmokeError(null)
    try {
      const data = await run()
      if (profileEpoch.current !== stamp) return
      applySmoke(seq, day, data)
    } catch (caught) {
      if (!alive.current || smokeSeq.current !== seq || profileEpoch.current !== stamp) return
      if (caught instanceof AuthError) onUnauthorized()
      else setSmokeError(caught instanceof Error ? caught.message : 'Не сохранилось.')
    } finally {
      if (alive.current && smokeSeq.current === seq && profileEpoch.current === stamp) setSmokePending(false)
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

  async function runShopping(run: () => Promise<ShoppingPayload>): Promise<boolean> {
    const seq = ++shoppingSeq.current
    const stamp = profileEpoch.current
    setShoppingPending(true)
    setShoppingError(null)
    try {
      const data = await run()
      if (!alive.current || shoppingSeq.current !== seq || profileEpoch.current !== stamp) return true
      setShopping(data)
      setShoppingError(null)
      return true
    } catch (caught) {
      if (!alive.current || shoppingSeq.current !== seq || profileEpoch.current !== stamp) return false
      if (caught instanceof AuthError) onUnauthorized()
      else setShoppingError(caught instanceof Error ? caught.message : 'Не сохранилось.')
      return false
    } finally {
      if (alive.current && shoppingSeq.current === seq && profileEpoch.current === stamp) setShoppingPending(false)
    }
  }

  async function runWallet(run: () => Promise<WalletPayload>): Promise<boolean> {
    const seq = ++walletSeq.current
    const stamp = profileEpoch.current
    setWalletPending(true)
    setWalletError(null)
    try {
      const data = await run()
      if (!alive.current || walletSeq.current !== seq || profileEpoch.current !== stamp) return true
      setWallet(data)
      setWalletError(null)
      return true
    } catch (caught) {
      if (!alive.current || walletSeq.current !== seq || profileEpoch.current !== stamp) return false
      if (caught instanceof AuthError) onUnauthorized()
      else setWalletError(caught instanceof Error ? caught.message : 'Не сохранилось.')
      return false
    } finally {
      if (alive.current && walletSeq.current === seq && profileEpoch.current === stamp) setWalletPending(false)
    }
  }

  async function commit<T>(run: () => Promise<T>, apply: (value: T) => void, forceReload = false): Promise<boolean> {
    const stamp = profileEpoch.current
    setError(null)
    writesInFlight.current += 1
    writeEpoch.current += 1
    if (forceReload) pendingReload.current = true
    try {
      const value = await run()
      if (!alive.current || profileEpoch.current !== stamp) return true
      apply(value)
      return true
    } catch (caught) {
      if (profileEpoch.current !== stamp) return false
      report(caught)
      pendingReload.current = true
      return false
    } finally {
      if (profileEpoch.current === stamp) reloadIfNeeded()
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

  function openArchive() {
    setView('archive')
    setGroups(null)
    setError(null)
  }

  function loadProfiles() {
    setProfileError(null)
    api.profiles().then(
      async (data) => {
        if (!alive.current) return
        const current = data.profiles.find((item) => item.id === data.currentId) ?? data.profiles[0]
        const local = peekTheme()
        if (local && current && current.theme === 'paper' && data.profiles.length === 1) {
          try {
            const updated = await api.updateProfile(current.id, { theme: local })
            if (!alive.current) return
            forgetTheme()
            applyProfiles(updated)
            return
          } catch {
            if (!alive.current) return
          }
        } else if (local) {
          forgetTheme()
        }
        applyProfiles(data)
      },
      (caught: unknown) => {
        if (!alive.current) return
        if (caught instanceof AuthError) onUnauthorized()
        else setProfileError(caught instanceof Error ? caught.message : 'Не открылось.')
      },
    )
  }

  useEffect(() => {
    loadProfiles()
  }, [])

  async function onLogout() {
    try {
      await api.logout()
    } catch {
      // Выходим даже если сессия уже погасла.
    }
    onUnauthorized()
  }

  const profile = profiles?.find((item) => item.id === profileId) ?? null
  const theme: ThemeId = profile?.theme ?? 'paper'
  const profileName = profile?.name ?? ''
  applyTheme(theme)

  useEffect(() => {
    applyTheme(theme)
    const meta = document.querySelector('meta[name="theme-color"]')
    const current = THEMES.find((item) => item.id === theme) ?? THEMES[0]
    meta?.setAttribute('content', current.color)
  }, [theme])

  useEffect(() => {
    return () => {
      clearTheme()
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#f3eadc')
    }
  }, [])

  async function switchProfile(id: string): Promise<boolean> {
    if (id === profileId) return true
    try {
      applyProfiles(await api.useProfile(id))
      return true
    } catch (caught) {
      report(caught)
      return false
    }
  }

  async function addProfile(name: string): Promise<boolean> {
    try {
      applyProfiles(await api.addProfile(name))
      return true
    } catch (caught) {
      report(caught)
      return false
    }
  }

  async function renameProfile(name: string): Promise<boolean> {
    if (!profileId) return false
    try {
      applyProfiles(await api.updateProfile(profileId, { name }))
      return true
    } catch (caught) {
      report(caught)
      return false
    }
  }

  async function deleteProfile(): Promise<boolean> {
    if (!profileId) return false
    try {
      applyProfiles(await api.deleteProfile(profileId))
      return true
    } catch (caught) {
      report(caught)
      return false
    }
  }

  async function changeTheme(next: ThemeId) {
    if (!profileId || next === theme) return
    setProfiles((current) => current?.map((item) => (item.id === profileId ? { ...item, theme: next } : item)) ?? current)
    try {
      const data = await api.updateProfile(profileId, { theme: next })
      if (!alive.current) return
      applyProfiles(data)
    } catch (caught) {
      report(caught)
      try {
        const data = await api.profiles()
        if (alive.current) applyProfiles(data)
      } catch {
        // Ошибка смены вида уже на экране.
      }
    }
  }

  if (profileError) {
    return (
      <main className="page">
        <p className="note">{profileError}</p>
        <button type="button" className="carry" onClick={loadProfiles}>
          ещё раз
        </button>
      </main>
    )
  }
  if (!profileId || !profiles || !profile) {
    return (
      <main className="page">
        <p className="empty">Открываю</p>
      </main>
    )
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
        profileName={profileName}
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
      onCarry={(to) => {
        const day = selected
        void commit(() => api.carry(day, to), absorbCarry, true)
      }}
      profiles={profiles}
      profileId={profileId}
      profileName={profileName}
      theme={theme}
      onTheme={(next) => void changeTheme(next)}
      onSwitchProfile={switchProfile}
      onAddProfile={addProfile}
      onRenameProfile={renameProfile}
      onDeleteProfile={deleteProfile}
    />
    {createPortal(
      <div className="side-stack">
        <Float id="smoke" profileId={profileId}>
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
        </Float>
        <Float id="shop" profileId={profileId}>
        <ShopWindow
          shopping={shopping}
          error={shoppingError}
          pending={shoppingPending}
          onRetry={pullShopping}
          onAddGrocery={(title) => runShopping(() => api.addGrocery(title))}
          onRenameGrocery={(id, title) => void runShopping(() => api.renameGrocery(id, title))}
          onBuyGrocery={(id) => void runShopping(() => api.buyGrocery(id))}
          onAddOrder={(title, shop) => runShopping(() => api.addOrder(title, shop))}
          onUpdateOrder={(id, patch: { title?: string; shop?: string; status?: OrderStatus }) =>
            void runShopping(() => api.updateOrder(id, patch))
          }
          onDeleteOrder={(id) => void runShopping(() => api.deleteOrder(id))}
        />
        </Float>
        <Float id="wallet" profileId={profileId}>
        <WalletWindow
          profileId={profileId}
          wallet={wallet}
          error={walletError}
          pending={walletPending}
          onRetry={pullWallet}
          onAdd={(entry) => runWallet(() => api.addWallet(entry))}
          onDelete={(id) => void runWallet(() => api.deleteWallet(id))}
          onAddAccount={(name, kind) => runWallet(() => api.addWalletAccount(name, kind))}
          onRenameAccount={(id, name) => runWallet(() => api.renameWalletAccount(id, name))}
          onDeleteAccount={(id) => void runWallet(() => api.deleteWalletAccount(id))}
        />
        </Float>
      </div>,
      document.body,
    )}
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
