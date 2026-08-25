import { NextRequest, NextResponse } from "next/server";
import { publicStatus, verifyPassword, isDashboardLocked, isOpenRelay } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/settings — public status.
 *
 * When the dashboard is LOCKED and no auth header is provided, returns ONLY:
 *   { needsAuth: true }
 *
 * No hints about whether a password is set, when it was set, what the relay
 * mode is, etc. This is intentional — an attacker probing /api/settings
 * shouldn't learn anything about the deployment.
 *
 * When unlocked (or when authenticated), returns the full public status:
 *   { hasPassword, dashboardLocked, setupAt, envFallback, isOpenRelay,
 *     authenticated }
 */
export async function GET(req: NextRequest) {
  const status = await publicStatus();

  // Locked?
  if (status.dashboardLocked) {
    const token = req.headers.get("x-tor-relay-auth") || "";

    // Open relay — locking has no effect, return full status.
    if (status.isOpenRelay) {
      return NextResponse.json(
        { ...status, authenticated: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Has auth header? Verify it.
    if (token) {
      const ok = await verifyPassword(token);
      if (ok) {
        return NextResponse.json(
          { ...status, authenticated: true },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    // Not authenticated — return minimal response.
    return NextResponse.json(
      { needsAuth: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Not locked — return full status.
  return NextResponse.json(
    { ...status, authenticated: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
