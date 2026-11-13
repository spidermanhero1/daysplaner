import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

type Spot = { x: number; y: number; z: number }
type Book = Record<string, Partial<Record<string, Spot>>>

const KEY = 'plandays.spots'
const PAD = 8
const DRAG = 64

let zTop = 1

function readBook(): Book {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object') return {}
    return data as Book
  } catch {
    return {}
  }
}

function parseSpot(value: unknown): Spot | null {
  if (!value || typeof value !== 'object') return null
  const spot = value as { x?: unknown; y?: unknown; z?: unknown }
  if (typeof spot.x !== 'number' || typeof spot.y !== 'number') return null
  if (!Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return null
  const z = typeof spot.z === 'number' && Number.isFinite(spot.z) ? spot.z : 1
  return { x: spot.x, y: spot.y, z }
}

function readSpot(profileId: string, id: string): Spot | null {
  return parseSpot(readBook()[profileId]?.[id])
}

function writeSpot(profileId: string, id: string, spot: Spot) {
  try {
    const book = readBook()
    const page = { ...book[profileId], [id]: spot }
    localStorage.setItem(KEY, JSON.stringify({ ...book, [profileId]: page }))
  } catch {
    // Положение останется до перезагрузки.
  }
}

function clamp(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const maxX = Math.max(PAD, window.innerWidth - width - PAD)
  const maxY = Math.max(PAD, window.innerHeight - height - PAD)
  return {
    x: Math.round(Math.min(Math.max(PAD, x), maxX)),
    y: Math.round(Math.min(Math.max(PAD, y), maxY)),
  }
}

function rememberZ(spot: Spot | null): Spot | null {
  if (spot && spot.z > zTop) zTop = spot.z
  return spot
}

export function Float({ id, profileId, children }: { id: string; profileId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [spot, setSpot] = useState<Spot | null>(() => rememberZ(readSpot(profileId, id)))
  const [z, setZ] = useState(() => spot?.z ?? 1)
  const [dragging, setDragging] = useState(false)
  const spotRef = useRef(spot)
  const savedRef = useRef(spot)
  const drag = useRef<{
    pointer: number
    startX: number
    startY: number
    originX: number
    originY: number
    width: number
    height: number
    z: number
    active: boolean
  } | null>(null)

  useEffect(() => {
    const next = rememberZ(readSpot(profileId, id))
    savedRef.current = next
    spotRef.current = next
    setSpot(next)
    setZ(next?.z ?? 1)
  }, [profileId, id])

  useEffect(() => {
    if (!dragging) return
    document.documentElement.classList.add('is-dragging-desk')
    return () => document.documentElement.classList.remove('is-dragging-desk')
  }, [dragging])

  useEffect(() => {
    const node = ref.current
    if (!node) return
    function fit() {
      if (drag.current?.active) return
      const saved = savedRef.current
      const box = ref.current
      if (!saved || !box) return
      const rect = box.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const next = { ...saved, ...clamp(saved.x, saved.y, rect.width, rect.height) }
      const current = spotRef.current
      if (current && current.x === next.x && current.y === next.y && current.z === next.z) return
      spotRef.current = next
      setSpot(next)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    window.addEventListener('resize', fit)
    window.visualViewport?.addEventListener('resize', fit)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
      window.visualViewport?.removeEventListener('resize', fit)
    }
  }, [profileId, id, spot !== null])

  function raise(): number {
    const nextZ = ++zTop
    setZ(nextZ)
    const saved = savedRef.current
    if (saved && saved.z !== nextZ) {
      const updated = { ...saved, z: nextZ }
      savedRef.current = updated
      writeSpot(profileId, id, updated)
      const visual = spotRef.current ? { ...spotRef.current, z: nextZ } : updated
      spotRef.current = visual
      setSpot(visual)
    }
    return nextZ
  }

  function finish(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    const placed = spotRef.current
    drag.current = null
    setDragging(false)
    const box = ref.current
    if (box?.hasPointerCapture(event.pointerId)) box.releasePointerCapture(event.pointerId)
    if (!current.active || !box || !placed) return
    const rect = box.getBoundingClientRect()
    const next = { ...placed, ...clamp(placed.x, placed.y, rect.width || current.width, rect.height || current.height) }
    savedRef.current = next
    spotRef.current = next
    setSpot(next)
    writeSpot(profileId, id, next)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    if (window.matchMedia('(max-width: 999px)').matches) return
    const nextZ = raise()
    const target = event.target
    if (!(target instanceof Element)) return
    if (!target.closest('.smoke-head')) return
    if (target.closest('button, input, textarea, select, a')) return
    const node = ref.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    drag.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      width: rect.width,
      height: rect.height,
      z: nextZ,
      active: false,
    }
    node.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (!current.active) {
      if (dx * dx + dy * dy < DRAG) return
      current.active = true
      setDragging(true)
    }
    const box = ref.current
    const rect = box?.getBoundingClientRect()
    const next = {
      ...clamp(
        current.originX + dx,
        current.originY + dy,
        rect && rect.width > 1 ? rect.width : current.width,
        rect && rect.height > 1 ? rect.height : current.height,
      ),
      z: current.z,
    }
    spotRef.current = next
    setSpot(next)
  }

  const names = ['desk']
  if (spot) names.push('is-placed')
  if (dragging) names.push('is-dragging')

  return (
    <div
      ref={ref}
      className={names.join(' ')}
      style={spot ? { left: spot.x, top: spot.y, zIndex: z } : { zIndex: z }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      {children}
    </div>
  )
}
