/**
 * In-memory request log store for tor-relay.
 *
 * Uses globalThis so the array survives Next.js dev HMR re-evaluations.
 * Last LOG_MAX entries are kept; oldest are evicted.
 *
 * Extends vertex-proxy-zai's schema with two new fields:
 *   - exitIp    : the Tor exit IP that the request was routed out through
 *   - provider  : which provider the target host belongs to (Vertex, Gemini, …)
 *   - viaTor    : true if the request actually went through Tor
 */

export type LogEntry = {
  id: string;
  ts: number;
  method: string;
  path: string;
  target: string | null;
  /** IP of the client that called our /api/proxy endpoint. */
  ip: string;
  /** Tor exit IP that the request was sent out through. */
  exitIp: string;
  /** true when the request actually went out through a Tor SOCKS circuit. */
  viaTor: boolean;
  /** Provider bucket the target host was matched to. */
  provider: string;
  ua: string;
  referer: string;
  status: number;
  durationMs: number;
  bytes: number | null;
  error: string | null;
};

const LOG_MAX = 1000;

type LogStore = LogEntry[];

const g = globalThis as typeof globalThis & { __tor_logs__?: LogStore };

function store(): LogStore {
  if (!g.__tor_logs__) g.__tor_logs__ = [];
  return g.__tor_logs__;
}

export function pushLog(entry: Omit<LogEntry, "id" | "ts">): LogEntry {
  const full: LogEntry = {
    id:
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36).slice(-4),
    ts: Date.now(),
    ...entry,
  };
  const s = store();
  s.unshift(full);
  if (s.length > LOG_MAX) s.length = LOG_MAX;
  return full;
}

export function getAllLogs(): LogEntry[] {
  return store();
}

export function deleteLog(id: string): boolean {
  const s = store();
  const i = s.findIndex((l) => l.id === id);
  if (i === -1) return false;
  s.splice(i, 1);
  return true;
}

export function clearLogs(): void {
  store().length = 0;
}

/** Hop-by-hop headers that should not be forwarded to the upstream target. */
export const HOP_HEADERS = new Set<string>([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "x-target-url",
  "x-proxy-key",
  "host",
  "content-length",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-forwarded-scheme",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "true-client-ip",
  "x-client-ip",
  "forwarded",
]);
