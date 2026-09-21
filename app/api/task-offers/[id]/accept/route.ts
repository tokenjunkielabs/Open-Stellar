import { NextResponse } from "next/server"
import { acceptTaskOffer, TaskOfferLifecycleError } from "@/lib/task-offers/lifecycle"

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

  try {
    const offer = acceptTaskOffer(decodeURIComponent(id), actorFromRequest(req))
    return NextResponse.json(
      { ok: true, offer, releaseTx: offer.releaseTx },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    return errorResponse(error)
  }
}
