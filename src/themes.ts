import { type ThemeId } from '../shared/themes.ts'

export type { ThemeId }

export const THEMES: readonly { id: ThemeId; name: string; color: string }[] = [
  { id: 'paper', name: 'бумага', color: '#f3eadc' },
  { id: 'duga', name: 'дуга', color: '#1a100c' },
  { id: 'birch', name: 'берёзы', color: '#1c1610' },
  { id: 'fire', name: 'костёр', color: '#1a120c' },
  { id: 'poppy', name: 'маки', color: '#f7f3ea' },
  { id: 'cabin', name: 'изба', color: '#0c1016' },
  { id: 'beam', name: 'луч', color: '#1a140e' },
  { id: 'burst', name: 'выброс', color: '#0c1218' },
  { id: 'ether', name: 'эфир', color: '#0c1014' },
]

const KEY = 'plandays-theme'
const LIGHT = new Set<ThemeId>(['poppy'])

export function themeTone(id: ThemeId): 'light' | 'dark' | undefined {
  if (id === 'paper') return undefined
  return LIGHT.has(id) ? 'light' : 'dark'
}

export function peekTheme(): ThemeId | null {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && saved !== 'paper' && THEMES.some((theme) => theme.id === saved)) return saved as ThemeId
  } catch {
    // приватный режим — фон останется у профиля как есть
  }
  return null
}

export function forgetTheme() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // нечего забывать
  }
}
