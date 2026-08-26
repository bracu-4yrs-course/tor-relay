import { NextResponse } from "next/server";

/** Platform healthcheck endpoint (Railway/Render probe /health). Returns
 *  immediately — never boots or probes the network daemon — so the probe
 *  is instant and can't time out during first-boot downloads. */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
