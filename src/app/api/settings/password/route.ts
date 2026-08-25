import { NextRequest, NextResponse } from "next/server";
import { hasPassword, setPassword, verifyPassword } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/settings/password
 *   Body: { current?: string, next: string }
 *
 * - First-run setup (no password set yet): `current` is ignored, sets the
 *   password. This is the "set password from inside the website" flow.
 * - Change password (already set): `current` must match the stored hash.
 *
 * Auth model:
 *   - If a password is already set, the caller must ALSO pass the current
 *     password. The `current` field doubles as the auth proof.
 *   - If no password is set, anyone can set one (first-run).
 */
export async function POST(req: NextRequest) {
  let body: { current?: string; next?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const next = (body.next || "").trim();
  const current = (body.current || "").trim();

  // If already set, the `current` field must authenticate AND match what
  // we compare inside setPassword (defense in depth).
  const alreadySet = await hasPassword();
  if (alreadySet) {
    const ok = await verifyPassword(current);
    if (!ok) {
      return NextResponse.json(
        { ok: false, error: "Current password is incorrect." },
        { status: 401 },
      );
    }
  }

  const result = await setPassword(next, current);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
