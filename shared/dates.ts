/** Граница дня: UTC+7 круглый год, без перевода часов. */
export const DAY_TIME_ZONE = 'Asia/Bangkok'

export function todayKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function addDays(key: string, delta: number): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + delta))
  return date.toISOString().slice(0, 10)
}

function atNoonUtc(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, 12))
}

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase('ru-RU') + value.slice(1)
}

export function weekdayOf(key: string): string {
  const name = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(atNoonUtc(key))
  return capitalize(name)
}

export function dateLineOf(key: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(atNoonUtc(key))
}

const SHORT_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

export function shortDateOf(key: string): string {
  const [, month, day] = key.split('-').map(Number)
  return `${day} ${SHORT_MONTHS[month - 1]}`
}

export function relativeLabel(day: string, today: string): string | null {
  if (day === today) return 'сегодня'
  if (day === addDays(today, -1)) return 'вчера'
  if (day === addDays(today, 1)) return 'завтра'
  return null
}

export function monthStart(key: string): string {
  return `${key.slice(0, 7)}-01`
}

export function addMonths(key: string, delta: number): string {
  const [year, month, day] = key.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1))
  const last = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate()
  const clamped = Math.min(day, last)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), clamped)).toISOString().slice(0, 10)
}

export function startOfWeek(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  return addDays(key, mondayOffset)
}

export function weekDays(key: string): string[] {
  const start = startOfWeek(key)
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

export function monthGrid(key: string): string[] {
  const first = monthStart(key)
  const start = startOfWeek(first)
  const [year, month] = first.split('-').map(Number)
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const last = `${first.slice(0, 8)}${String(lastDate).padStart(2, '0')}`
  const end = addDays(startOfWeek(last), 6)
  const days: string[] = []
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day)
  return days
}

export function monthTitleOf(key: string): string {
  const name = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    timeZone: 'UTC',
  }).format(atNoonUtc(monthStart(key)))
  return `${capitalize(name)} ${key.slice(0, 4)}`
}

export function isDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function resolveDay(param: string, today = todayKey()): string | null {
  if (param === 'today') return today
  return isDayKey(param) ? param : null
}

export function spanDays(from: string, to: string): number | null {
  if (!isDayKey(from) || !isDayKey(to) || from > to) return null
  let count = 1
  let cursor = from
  while (cursor < to) {
    cursor = addDays(cursor, 1)
    count += 1
    if (count > 42) return count
  }
  return count
}
