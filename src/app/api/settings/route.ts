import { NextRequest, NextResponse } from "next/server";
import { publicStatus, verifyPassword } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/settings — public status (no secrets).
 *
 * Response:
 *   { hasPassword, dashboardLocked, setupAt, envFallback, isOpenRelay }
 *
 * If the dashboard is locked, this endpoint still returns public status
 * (it's needed by the login screen). No secrets are ever returned.
 */
export async function GET(req: NextRequest) {
  const status = await publicStatus();

  // If the dashboard is locked, also verify the caller is authenticated.
  // The unlock cookie/header is checked here; the login screen uses this
  // endpoint to know whether to prompt.
  if (status.dashboardLocked) {
    const token = req.headers.get("x-tor-relay-auth") || "";
    if (token) {
      const ok = await verifyPassword(token);
      if (!ok) {
        return NextResponse.json(
          { ...status, authenticated: false },
          { status: 401 },
        );
      }
      return NextResponse.json(
        { ...status, authenticated: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ...status, authenticated: false },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ...status, authenticated: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
