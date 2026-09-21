export type TaskOfferAsset = "XLM" | "USDC"
export type TaskOfferStatus = "open" | "claimed" | "delivered" | "accepted" | "disputed" | "expired" | "cancelled"

export interface TaskOfferReward {
  amount: string
  asset: TaskOfferAsset
}

export interface TaskOfferTransition {
  from: TaskOfferStatus
  to: TaskOfferStatus
  actorId: string
  at: string
}

export interface TaskOffer {
  offerId: string
  postedBy: string
  requiredCapability: string
  payload: unknown
  reward: TaskOfferReward
  deadline: number
  status: TaskOfferStatus
  escrowTx: string
  refundTx?: string
  workerAgentId?: string
  result?: unknown
  deliveredAt?: string
  acceptedAt?: string
  disputedAt?: string
  releaseTx?: string
  disputeTx?: string
  transitionLog: TaskOfferTransition[]
  createdAt: string
  updatedAt: string
}

export interface CreateTaskOfferInput {
  postedBy: string
  requiredCapability: string
  payload?: unknown
  reward: string | Partial<TaskOfferReward>
  deadline: number
}

interface TaskOfferState {
  offers: Map<string, TaskOffer>
  sequence: number
}

const globalState = globalThis as typeof globalThis & {
  __openStellarTaskOffers__?: TaskOfferState
}

const state: TaskOfferState = globalState.__openStellarTaskOffers__ ?? {
  offers: new Map(),
  sequence: 0,
}

globalState.__openStellarTaskOffers__ ??= state

const TASK_OFFER_TRANSITIONS: Record<TaskOfferStatus, readonly TaskOfferStatus[]> = {
  open: ["claimed", "expired", "cancelled"],
  claimed: ["delivered"],
  delivered: ["accepted", "disputed"],
  accepted: [],
  disputed: [],
  expired: [],
  cancelled: [],
}

export class TaskOfferStateError extends Error {
  readonly currentStatus: TaskOfferStatus

  constructor(message: string, currentStatus: TaskOfferStatus) {
    super(message)
    this.name = "TaskOfferStateError"
    this.currentStatus = currentStatus
  }
}

function assertNonEmpty(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw new Error(`${field} is required`)
  return text
}

function nextOfferId(): string {
  state.sequence += 1
  return `off_${Date.now().toString(36)}_${state.sequence.toString(36)}`
}

function isTaskOfferAsset(value: unknown): value is TaskOfferAsset {
  return value === "XLM" || value === "USDC"
}

function normalizeReward(reward: string | Partial<TaskOfferReward>): TaskOfferReward {
  if (typeof reward === "string") {
    const match = /^(\d+(?:\.\d+)?)\s+(XLM|USDC)$/i.exec(reward.trim())
    if (!match) throw new Error("reward must be formatted like '0.05 XLM'")
    const amount = match[1]
    const asset = match[2].toUpperCase()
    if (Number(amount) <= 0) throw new Error("reward amount must be > 0")
    if (!isTaskOfferAsset(asset)) throw new Error("reward asset must be XLM or USDC")
    return { amount, asset }
  }

  if (!reward || typeof reward !== "object") {
    throw new Error("reward is required")
  }

  const amount = String(reward.amount ?? "").trim()
  const asset = String(reward.asset ?? "").trim().toUpperCase()
  if (!amount || Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
    throw new Error("reward amount must be > 0")
  }
  if (!isTaskOfferAsset(asset)) throw new Error("reward asset must be XLM or USDC")
  return { amount, asset }
}

function normalizeDeadline(deadline: number): number {
  const value = Number(deadline)
  if (!Number.isFinite(value)) throw new Error("deadline must be a unix timestamp")
  const timestamp = value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  if (timestamp <= Math.floor(Date.now() / 1000)) throw new Error("deadline must be in the future")
  return timestamp
}

export function taskOfferSettlementRef(prefix: "escrow" | "refund" | "release" | "dispute", offerId: string): string {
  return `${prefix}_${offerId}_${crypto.randomUUID()}`
}

function transitionAllowed(from: TaskOfferStatus, to: TaskOfferStatus): boolean {
  return TASK_OFFER_TRANSITIONS[from].includes(to)
}

export function transitionTaskOffer(
  offerId: string,
  to: TaskOfferStatus,
  actorId: string,
  patch: Partial<Omit<TaskOffer, "offerId" | "status" | "updatedAt" | "transitionLog">> = {},
): TaskOffer {
  const current = getTaskOffer(offerId)
  if (!current) throw new Error("Task offer not found")
  if (!transitionAllowed(current.status, to)) {
    throw new TaskOfferStateError(
      `Cannot transition task offer from ${current.status} to ${to}`,
      current.status,
    )
  }

  const now = new Date().toISOString()
  const next: TaskOffer = {
    ...current,
    ...patch,
    status: to,
    updatedAt: now,
    transitionLog: [
      ...current.transitionLog,
      { from: current.status, to, actorId, at: now },
    ],
  }
  state.offers.set(offerId, next)
  return next
}

function refreshOfferExpiry(offer: TaskOffer): TaskOffer {
  if (offer.status !== "open" || offer.deadline > Math.floor(Date.now() / 1000)) {
    return offer
  }
  return transitionTaskOffer(offer.offerId, "expired", "system:expiry", {
    refundTx: offer.refundTx ?? taskOfferSettlementRef("refund", offer.offerId),
  })
}

export function resetTaskOffersForTests(): void {
  state.offers.clear()
  state.sequence = 0
}

export function createTaskOffer(input: CreateTaskOfferInput): TaskOffer {
  const now = new Date().toISOString()
  const offerId = nextOfferId()
  const offer: TaskOffer = {
    offerId,
    postedBy: assertNonEmpty(input.postedBy, "postedBy"),
    requiredCapability: assertNonEmpty(input.requiredCapability, "requiredCapability"),
    payload: input.payload ?? {},
    reward: normalizeReward(input.reward),
    deadline: normalizeDeadline(input.deadline),
    status: "open",
    escrowTx: taskOfferSettlementRef("escrow", offerId),
    transitionLog: [],
    createdAt: now,
    updatedAt: now,
  }
  state.offers.set(offer.offerId, offer)
  return offer
}

export function getTaskOffer(offerId: string): TaskOffer | null {
  const offer = state.offers.get(offerId)
  return offer ? refreshOfferExpiry(offer) : null
}

export function listTaskOffers(filters: { requiredCapability?: string; includeExpired?: boolean } = {}): TaskOffer[] {
  return [...state.offers.values()]
    .map(refreshOfferExpiry)
    .filter((offer) => filters.includeExpired || offer.status === "open")
    .filter((offer) => !filters.requiredCapability || offer.requiredCapability === filters.requiredCapability)
    .sort((a, b) => a.deadline - b.deadline || a.offerId.localeCompare(b.offerId))
}

export function cancelTaskOffer(offerId: string, actorId: string): TaskOffer {
  const offer = getTaskOffer(offerId)
  if (!offer) throw new Error("Task offer not found")
  if (offer.postedBy !== actorId) throw new Error("Only the poster can cancel this offer")
  if (offer.status !== "open") {
    throw new TaskOfferStateError("Only open offers can be cancelled", offer.status)
  }

  return transitionTaskOffer(offerId, "cancelled", actorId, {
    refundTx: offer.refundTx ?? taskOfferSettlementRef("refund", offer.offerId),
  })
}
