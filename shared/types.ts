import type { ThemeId } from './themes.ts'

export type Priority = 'normal' | 'important'

export type Task = {
  id: string
  title: string
  day: string
  parentId: string | null
  position: number
  priority: Priority
  done: boolean
  doneAt: string | null
  createdAt: string
}

export type DayPayload = {
  day: string
  today: string
  tasks: Task[]
}

export type SpanPayload = {
  from: string
  to: string
  today: string
  tasks: Task[]
}

export type CarryPayload = DayPayload & {
  moved: number
  to: string
}

export type ArchiveGroup = {
  day: string
  tasks: Task[]
}

export type ArchivePayload = {
  today: string
  groups: ArchiveGroup[]
}

export type SessionPayload = {
  required: boolean
  ok: boolean
}

/** Сигарет в закрытой пачке. */
export const PACK_SIZE = 20

/** Потолок запаса: пачки и шишки по отдельности. */
export const SMOKE_MAX = 500

export type SmokeKind = 'cig' | 'joint'

export type SmokeBreak = {
  id: string
  day: string
  kind: SmokeKind
  createdAt: string
}

export type SmokePayload = {
  day: string
  today: string
  packSize: number
  packs: number
  open: number
  joints: number
  smokedCigs: number
  smokedJoints: number
  breaks: SmokeBreak[]
  latestId: string | null
}

/** Магазин, если при добавлении заказа поле пустое. */
export const DEFAULT_SHOP = 'Лазада'

export type OrderStatus = 'need' | 'ordered' | 'arrived'

export type Grocery = {
  id: string
  title: string
  createdAt: string
}

export type MarketOrder = {
  id: string
  title: string
  shop: string
  status: OrderStatus
  createdAt: string
}

export type ShoppingPayload = {
  groceries: Grocery[]
  orders: MarketOrder[]
}

export type Profile = {
  id: string
  name: string
  theme: ThemeId
}

export type ProfilesPayload = {
  profiles: Profile[]
  currentId: string
}
