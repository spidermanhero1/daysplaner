export const THEME_IDS = ['paper', 'duga', 'birch', 'fire', 'poppy', 'cabin', 'beam', 'burst', 'ether'] as const

export type ThemeId = (typeof THEME_IDS)[number]

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}
