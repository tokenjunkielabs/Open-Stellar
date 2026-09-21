import { NextResponse } from "next/server"
import { publishSystemEvent } from "@/lib/events/system-events"
import { deliverTaskOffer, TaskOfferLifecycleError } from "@/lib/task-offers/lifecycle"

type RouteContext = { params: Promise<{ id: string }> }

function actorFromRequest(req: Request): string {
  const url = new URL(req.url)
  return String(req.headers.get("x-agent-id") ?? url.searchParams.get("agentId") ?? "").trim()
}

function errorResponse(error: unknown) {
  if (error instanceof TaskOfferLifecycleError) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        code: error.code,
        ...(error.currentStatus ? { currentStatus: error.currentStatus } : {}),
      },
      { status: error.statusCode, headers: { "Cache-Control": "no-store" } },
    )
  }

  return NextResponse.json(
    { ok: false, error: "Task offer lifecycle request failed" },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  )
}

export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params
  const body = await req.json().catch(() => null)

  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "result")) {
    return NextResponse.json(
      { ok: false, error: "result is required", code: "TASK_OFFER_RESULT_REQUIRED" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  }

  try {
    const offer = deliverTaskOffer(
      decodeURIComponent(id),
      actorFromRequest(req),
      (body as { result: unknown }).result,
    )

    publishSystemEvent({
      type: "task.offer.delivered",
      agentId: offer.postedBy,
      offerId: offer.offerId,
      workerAgentId: offer.workerAgentId ?? "",
      result: offer.result,
    })

    return NextResponse.json({ ok: true, offer }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return errorResponse(error)
  }
}
