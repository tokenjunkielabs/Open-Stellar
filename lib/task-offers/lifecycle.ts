import {
  getTaskOffer,
  listTaskOffers,
  taskOfferSettlementRef,
  transitionTaskOffer,
  type TaskOffer,
  type TaskOfferStatus,
} from "@/lib/task-market/offers"

export const DELIVERY_ACCEPT_TIMEOUT_MS = 10 * 60 * 1000

export class TaskOfferLifecycleError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly currentStatus?: TaskOfferStatus

  constructor(
    message: string,
    statusCode: number,
    code: string,
    currentStatus?: TaskOfferStatus,
  ) {
    super(message)
    this.name = "TaskOfferLifecycleError"
    this.statusCode = statusCode
    this.code = code
    this.currentStatus = currentStatus
  }
}

function requireOffer(offerId: string): TaskOffer {
  const offer = getTaskOffer(offerId)
  if (!offer) {
    throw new TaskOfferLifecycleError("Task offer not found", 404, "TASK_OFFER_NOT_FOUND")
  }
  return offer
}

function conflict(offer: TaskOffer, expected: string): never {
  throw new TaskOfferLifecycleError(
    `Task offer must be ${expected}; current state is ${offer.status}`,
    409,
    "INVALID_TASK_OFFER_TRANSITION",
    offer.status,
  )
}

function requireActor(actorId: string): string {
  const actor = actorId.trim()
  if (!actor) {
    throw new TaskOfferLifecycleError("agentId is required", 400, "AGENT_ID_REQUIRED")
  }
  return actor
}

export function claimTaskOffer(offerId: string, actorId: string): TaskOffer {
  const actor = requireActor(actorId)
  const offer = requireOffer(offerId)

  if (offer.status !== "open") conflict(offer, "open")

  // The read + transition are synchronous against #113's shared store. That
  // makes this compare-and-set indivisible inside the current API process:
  // the first caller moves open -> claimed and every later caller sees claimed.
  return transitionTaskOffer(offer.offerId, "claimed", actor, {
    workerAgentId: actor,
  })
}

export function deliverTaskOffer(
  offerId: string,
  actorId: string,
  result: unknown,
): TaskOffer {
  const actor = requireActor(actorId)
  const offer = requireOffer(offerId)

  if (offer.status !== "claimed") conflict(offer, "claimed")
  if (offer.workerAgentId !== actor) {
    throw new TaskOfferLifecycleError(
      "Only the claiming worker can deliver this task offer",
      403,
      "TASK_OFFER_WORKER_REQUIRED",
      offer.status,
    )
  }

  return transitionTaskOffer(offer.offerId, "delivered", actor, {
    result,
    deliveredAt: new Date().toISOString(),
  })
}

export function acceptTaskOffer(offerId: string, actorId: string): TaskOffer {
  const actor = requireActor(actorId)
  const offer = requireOffer(offerId)

  if (offer.postedBy !== actor) {
    throw new TaskOfferLifecycleError(
      "Only the poster can accept this task offer",
      403,
      "TASK_OFFER_POSTER_REQUIRED",
      offer.status,
    )
  }

  // Accept is deliberately idempotent: a retry returns the same settlement
  // reference instead of generating a second release/payment.
  if (offer.status === "accepted" && offer.releaseTx) return offer
  if (offer.status !== "delivered") conflict(offer, "delivered")

  return transitionTaskOffer(offer.offerId, "accepted", actor, {
    acceptedAt: new Date().toISOString(),
    releaseTx: offer.releaseTx ?? taskOfferSettlementRef("release", offer.offerId),
  })
}

export function disputeTaskOffer(offerId: string, actorId: string): TaskOffer {
  const actor = requireActor(actorId)
  const offer = requireOffer(offerId)

  if (offer.postedBy !== actor) {
    throw new TaskOfferLifecycleError(
      "Only the poster can dispute this task offer",
      403,
      "TASK_OFFER_POSTER_REQUIRED",
      offer.status,
    )
  }

  if (offer.status === "disputed" && offer.disputeTx) return offer
  if (offer.status !== "delivered") conflict(offer, "delivered")

  return transitionTaskOffer(offer.offerId, "disputed", actor, {
    disputedAt: new Date().toISOString(),
    disputeTx: offer.disputeTx ?? taskOfferSettlementRef("dispute", offer.offerId),
  })
}

export function autoReleaseDeliveredTaskOffers(nowMs = Date.now()): TaskOffer[] {
  const released: TaskOffer[] = []

  for (const offer of listTaskOffers({ includeExpired: true })) {
    if (offer.status !== "delivered" || !offer.deliveredAt) continue
    const deliveredAt = Date.parse(offer.deliveredAt)
    if (!Number.isFinite(deliveredAt)) continue
    if (nowMs - deliveredAt < DELIVERY_ACCEPT_TIMEOUT_MS) continue

    released.push(
      transitionTaskOffer(offer.offerId, "accepted", "system:auto-release", {
        acceptedAt: new Date(nowMs).toISOString(),
        releaseTx: offer.releaseTx ?? taskOfferSettlementRef("release", offer.offerId),
      }),
    )
  }

  return released
}
