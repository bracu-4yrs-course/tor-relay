/**
 * In-app settings store (SQLite-backed via Prisma).
 *
 * Replaces the env-only PROXY_KEY model with one that can be edited from the
 * dashboard: the user sets / changes the proxy password from inside the UI,
 * the hash is persisted in the `Setting` table, and the proxy route checks
 * the DB first (env var PROXY_KEY remains as a fallback / bootstrap).
 *
 * Also adds a "dashboard locked" toggle: when locked, the dashboard itself
 * requires the password to view logs / settings.
 */

import { db } from "@/lib/db";
import bcrypt from "bcryptjs";

const K_PROXY_HASH = "proxy_key_hash"; // bcrypt hash
const K_DASH_LOCKED = "dashboard_locked"; // "true" | "false"
const K_SETUP_AT = "setup_at"; // ISO timestamp of first password set

/** Read a setting value, returning null if unset. */
async function get(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

/** Write a setting value (upsert). */
async function set(key: string, value: string): Promise<void> {
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/** True if a proxy password has been set in the DB. */
export async function hasPassword(): Promise<boolean> {
  const h = await get(K_PROXY_HASH);
  return !!h && h.length > 0;
}

/**
 * Verify a candidate password against the stored hash. Returns true if it
 * matches (or if no password is set AND the env var is also unset, i.e. open
 * relay mode).
 */
export async function verifyPassword(candidate: string): Promise<boolean> {
  const h = await get(K_PROXY_HASH);
  if (h) {
    try {
      return await bcrypt.compare(candidate, h);
    } catch {
      return false;
    }
  }
  // No DB password set — fall back to env var
  const env = process.env.PROXY_KEY?.trim();
  if (!env) return true; // open relay
  return candidate === env;
}

/** Get the effective "open" status: true when neither DB nor env has a password. */
export async function isOpenRelay(): Promise<boolean> {
  const h = await get(K_PROXY_HASH);
  if (h) return false;
  const env = process.env.PROXY_KEY?.trim();
  return !env;
}

/**
 * Set the proxy password. If `current` is provided and a password is already
 * set, it must match. If no password is set yet, `current` is ignored (first-
 * run setup).
 *
 * Returns { ok: true } on success, or { ok: false, error } on failure.
 */
export async function setPassword(
  next: string,
  current?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!next || next.length < 4) {
    return { ok: false, error: "Password must be at least 4 characters." };
  }
  if (next.length > 200) {
    return { ok: false, error: "Password must be at most 200 characters." };
  }

  const existingHash = await get(K_PROXY_HASH);
  if (existingHash) {
    if (!current) {
      return { ok: false, error: "Current password is required to change it." };
    }
    try {
      const ok = await bcrypt.compare(current, existingHash);
      if (!ok) return { ok: false, error: "Current password is incorrect." };
    } catch {
      return { ok: false, error: "Stored password hash is corrupt." };
    }
  }

  const hash = await bcrypt.hash(next, 10);
  await set(K_PROXY_HASH, hash);
  if (!existingHash) {
    await set(K_SETUP_AT, new Date().toISOString());
  }
  return { ok: true };
}

/** Clear the stored password (revert to env var / open). Requires `current`. */
export async function clearPassword(
  current: string,
): Promise<{ ok: boolean; error?: string }> {
  const existingHash = await get(K_PROXY_HASH);
  if (!existingHash) return { ok: false, error: "No password is set." };
  try {
    const ok = await bcrypt.compare(current, existingHash);
    if (!ok) return { ok: false, error: "Current password is incorrect." };
  } catch {
    return { ok: false, error: "Stored password hash is corrupt." };
  }
  await db.setting.delete({ where: { key: K_PROXY_HASH } });
  return { ok: true };
}

/** Dashboard lock state — when true, /api/logs and /api/settings require auth. */
export async function isDashboardLocked(): Promise<boolean> {
  return (await get(K_DASH_LOCKED)) === "true";
}

export async function setDashboardLocked(locked: boolean): Promise<void> {
  await set(K_DASH_LOCKED, locked ? "true" : "false");
}

/** Public summary — no secrets. Returned by GET /api/settings. */
export async function publicStatus(): Promise<{
  hasPassword: boolean;
  dashboardLocked: boolean;
  setupAt: string | null;
  envFallback: boolean;
  isOpenRelay: boolean;
}> {
  const h = await get(K_PROXY_HASH);
  const locked = await isDashboardLocked();
  const setupAt = await get(K_SETUP_AT);
  const env = process.env.PROXY_KEY?.trim();
  return {
    hasPassword: !!h,
    dashboardLocked: locked,
    setupAt,
    envFallback: !!env,
    isOpenRelay: !h && !env,
  };
}
