/**
 * Auth helpers shared by protected API routes.
 *
 * The model is intentionally stateless: the client sends the password on
 * every authenticated request via the `x-tor-relay-auth` header (or ?auth=
 * query param). We verify it against the stored hash on each call. This
 * keeps the proxy entirely stateless and avoids cookie / session surface
 * area.
 */

import { NextRequest, NextResponse } from "next/server";
import { isDashboardLocked, isOpenRelay, verifyPassword } from "@/lib/settings";

export type AuthOutcome =
  | { ok: true; password: string }
  | { ok: false; response: NextResponse };

/** Extract the password candidate from request headers / query. */
function extractPassword(req: NextRequest): string {
  return (
    req.headers.get("x-tor-relay-auth") ||
    new URL(req.url).searchParams.get("auth") ||
    ""
  );
}

/**
 * Returns the password if the request is authenticated; otherwise a 401
 * response. Use this in endpoints that are gated when the dashboard is
 * locked.
 *
 * If the dashboard is NOT locked, returns { ok: true, password: "" } so
 * the endpoint proceeds normally (no auth required).
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
        { ok: false, error: "Authentication required.", needsAuth: true },
        { status: 401 },
      ),
    };
  }

  const ok = await verifyPassword(pwd);
  if (!ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "Incorrect password.", needsAuth: true },
        { status: 401 },
      ),
    };
  }

  return { ok: true, password: pwd };
}
