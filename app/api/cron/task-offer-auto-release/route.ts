import { NextResponse } from "next/server"
import { autoReleaseDeliveredTaskOffers } from "@/lib/task-offers/lifecycle"

function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return req.headers.get("authorization") === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized cron request" }, { status: 401 })
  }

  const released = autoReleaseDeliveredTaskOffers()
  return NextResponse.json(
    {
      ok: true,
      released: released.map((offer) => ({
        offerId: offer.offerId,
        workerAgentId: offer.workerAgentId,
        releaseTx: offer.releaseTx,
        acceptedAt: offer.acceptedAt,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
