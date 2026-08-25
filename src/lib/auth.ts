/**
 * Auth helper for protected routes.
 *
 * The middleware approach doesn't work because Next.js middleware runs on
 * the Edge runtime by default, and Prisma needs Node.js. So we do the
 * auth check inline in each route handler.
 *
 * Usage:
 *   export async function GET(req: NextRequest) {
 *     const auth = await requireAuthIfLocked(req);
 *     if (!auth.ok) return auth.response;
 *     // ... route logic
 *   }
 *
 * When the dashboard is locked AND the caller is unauthenticated, this
 * returns a 404 (not 401!) so an attacker can't even tell that the
 * endpoint exists. The only routes that always respond are /, /api/auth,
 * and /api/settings (which itself returns {needsAuth:true} when locked).
 */

import { NextRequest, NextResponse } from "next/server";
import { isDashboardLocked, isOpenRelay, verifyPassword } from "@/lib/settings";

export type AuthOutcome =
  | { ok: true; password: string }
  | { ok: false; response: NextResponse };

function extractPassword(req: NextRequest): string {
  return (
    req.headers.get("x-tor-relay-auth") ||
    new URL(req.url).searchParams.get("auth") ||
    ""
  );
}

/**
 * Returns the password if the request is authenticated (or if the dashboard
 * isn't locked). Otherwise returns a 404 response — NOT 401, because we don't
 * want to confirm the endpoint exists.
 */
export async function requireAuthIfLocked(
  req: NextRequest,
): Promise<AuthOutcome> {
  const locked = await isDashboardLocked();
  if (!locked) return { ok: true, password: "" };

  const open = await isOpenRelay();
  if (open) return { ok: true, password: "" };

  const pwd = extractPassword(req);
  if (!pwd) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Not Found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  const ok = await verifyPassword(pwd);
  if (!ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Not Found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      ),
    };
  }

  return { ok: true, password: pwd };
}
