import { useEffect, useRef } from 'react'

const HAND = '(max-width: 999px)'

export function useSwipeBack<T extends HTMLElement>(enabled: boolean, onBack: () => void) {
  const ref = useRef<T>(null)
  const backRef = useRef(onBack)
  backRef.current = onBack

  useEffect(() => {
    const node = ref.current
    if (!node || !enabled) return
    if (window.matchMedia(HAND).matches === false) return
    const box: T = node

    let pointer = -1
    let startX = 0
    let startY = 0
    let dx = 0
    let tracking = false
    let dragging = false
    let timer = 0
    let cancel = false

    function reset() {
      box.style.transition = ''
      box.style.transform = ''
    }

    function down(event: PointerEvent) {
      if (!event.isPrimary || event.pointerType === 'mouse') return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('input, textarea, select, label, .pane-handle, .chip-handle, .pane-back, .pane-actions, .pane-compose, .smoke-actions')) {
        return
      }
      pointer = event.pointerId
      startX = event.clientX
      startY = event.clientY
      dx = 0
      tracking = true
      dragging = false
    }

    function move(event: PointerEvent) {
      if (!tracking || event.pointerId !== pointer) return
      const x = event.clientX - startX
      const y = event.clientY - startY
      if (!dragging) {
        if (Math.abs(x) < 12 && Math.abs(y) < 12) return
        if (x < 12 || Math.abs(y) > Math.abs(x) * 0.9) {
          tracking = false
          return
        }
        dragging = true
        box.style.transition = 'none'
        if (!box.hasPointerCapture(event.pointerId)) box.setPointerCapture(event.pointerId)
      }
      dx = Math.max(0, x)
      box.style.transform = `translate3d(${dx}px, 0, 0)`
    }

    function up(event: PointerEvent) {
      if (event.pointerId !== pointer) return
      const was = dragging
      const moved = dx
      tracking = false
      dragging = false
      pointer = -1
      if (!was) return
      const width = box.getBoundingClientRect().width
      const pass = moved > Math.max(64, Math.min(120, width * 0.22))
      if (!pass) {
        box.style.transition = 'transform 180ms ease'
        box.style.transform = ''
        window.setTimeout(reset, 200)
        return
      }
      box.style.transition = 'transform 180ms ease'
      box.style.transform = 'translate3d(100%, 0, 0)'
      const eat = (click: Event) => {
        click.preventDefault()
        click.stopPropagation()
      }
      box.addEventListener('click', eat, true)
      window.setTimeout(() => box.removeEventListener('click', eat, true), 450)
      timer = window.setTimeout(() => {
        if (!cancel) backRef.current()
      }, 170)
    }

    box.addEventListener('pointerdown', down)
    box.addEventListener('pointermove', move)
    box.addEventListener('pointerup', up)
    box.addEventListener('pointercancel', up)
    return () => {
      cancel = true
      window.clearTimeout(timer)
      box.removeEventListener('pointerdown', down)
      box.removeEventListener('pointermove', move)
      box.removeEventListener('pointerup', up)
      box.removeEventListener('pointercancel', up)
      reset()
    }
  }, [enabled])

  return ref
}
