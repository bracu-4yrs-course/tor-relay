"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Activity,
  ArrowRight,
  Ban,
  Boxes,
  CheckCircle2,
  Clock,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  Network,
  Pause,
  Play,
  Search,
  Server,
  Settings as SettingsIcon,
  Shield,
  ShieldCheck,
  Shuffle,
  Trash2,
  Unlock,
  Wifi,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

type LogEntry = {
  id: string;
  ts: number;
  method: string;
  path: string;
  target: string | null;
  ip: string;
  exitIp: string;
  viaTor: boolean;
  provider: string;
  ua: string;
  referer: string;
  status: number;
  durationMs: number;
  bytes: number | null;
  error: string | null;
};

type TorStatus = {
  state: string;
  binary: string;
  socks: string;
  pid: number | null;
  uptime_s: number | null;
  restarts: number;
  mock: boolean;
  recent_log: string[];
};

type ProviderInfo = {
  id: string;
  name: string;
  color: string;
  description: string;
  hostCount: number;
  hosts: string[];
};

type SettingsStatus = {
  hasPassword: boolean;
  dashboardLocked: boolean;
  setupAt: string | null;
  envFallback: boolean;
  isOpenRelay: boolean;
  authenticated?: boolean;
};

const methodColor: Record<string, string> = {
  GET: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  POST: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  DELETE: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  PUT: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  PATCH: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  HEAD: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  OPTIONS: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

// BUG FIX (v2): the old code did `torStateColor(...).replace("text-", "border-")`
// which produced class names like `border-emerald-300` that Tailwind purges
// because they never appear literally. Now we define both text and border
// variants as literal strings so they survive the purge.
const torStateStyle: Record<
  string,
  { text: string; border: string; bg: string }
> = {
  ready: {
    text: "text-emerald-300",
    border: "border-emerald-500/40",
    bg: "bg-emerald-500/10",
  },
  mock: {
    text: "text-amber-300",
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
  },
  starting: {
    text: "text-sky-300",
    border: "border-sky-500/40",
    bg: "bg-sky-500/10",
  },
  stopped: {
    text: "text-slate-400",
    border: "border-slate-600",
    bg: "bg-slate-700/20",
  },
  disabled: {
    text: "text-slate-400",
    border: "border-slate-600",
    bg: "bg-slate-700/20",
  },
  "binary-missing": {
    text: "text-rose-300",
    border: "border-rose-500/40",
    bg: "bg-rose-500/10",
  },
  timeout: {
    text: "text-rose-300",
    border: "border-rose-500/40",
    bg: "bg-rose-500/10",
  },
  exited: {
    text: "text-rose-300",
    border: "border-rose-500/40",
    bg: "bg-rose-500/10",
  },
};

const providerColor: Record<string, string> = {
  vertex: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  gemini: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  openai: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  anthropic: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  zai: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  ipify: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  test: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  auth: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30",
  unknown: "bg-slate-700/40 text-slate-300 border-slate-600",
};

const providerLabel: Record<string, string> = {
  vertex: "Vertex",
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  zai: "Z.ai",
  ipify: "ipify",
  test: "test",
  auth: "auth",
  unknown: "unknown",
  "—": "—",
};

function statusClass(s: number): string {
  if (s >= 500) return "text-rose-300";
  if (s >= 400) return "text-amber-300";
  if (s >= 300) return "text-sky-300";
  return "text-emerald-300";
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `.${p(d.getMilliseconds(), 3)}`
  );
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function Home() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [tor, setTor] = useState<TorStatus | null>(null);
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(
    null,
  );
  const [authPassword, setAuthPassword] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<"logs" | "providers" | "tor" | "settings">(
    "logs",
  );

  // Persist the password in-memory so it's sent on every authenticated call.
  // This is intentionally NOT a cookie / localStorage — clearing the tab
  // clears the auth.
  const authRef = useRef<string>("");
  const setAuth = useCallback((pwd: string) => {
    authRef.current = pwd;
    setAuthPassword(pwd);
  }, []);

  const authHeader = useCallback((): HeadersInit => {
    return authRef.current
      ? { "x-tor-relay-auth": authRef.current }
      : {};
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const r = await fetch("/api/logs", {
        cache: "no-store",
        headers: authHeader(),
      });
      if (r.status === 401) {
        // Dashboard is locked — surface that to the user.
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { logs: LogEntry[] };
      setLogs(data.logs || []);
    } catch (e) {
      console.error("fetch logs failed:", e);
    } finally {
      setLoading(false);
    }
  }, [authHeader]);

  const fetchProviders = useCallback(async () => {
    try {
      const r = await fetch("/api/providers", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as { providers: ProviderInfo[] };
      setProviders(data.providers || []);
    } catch (e) {
      console.error("fetch providers failed:", e);
    }
  }, []);

  const fetchTor = useCallback(async () => {
    try {
      const r = await fetch("/api/tor", {
        cache: "no-store",
        headers: authHeader(),
      });
      if (!r.ok) return;
      const data = (await r.json()) as { tor: TorStatus };
      setTor(data.tor);
    } catch (e) {
      console.error("fetch tor failed:", e);
    }
  }, [authHeader]);

  const fetchSettings = useCallback(async () => {
    try {
      const r = await fetch("/api/settings", {
        cache: "no-store",
        headers: authHeader(),
      });
      const data = (await r.json()) as SettingsStatus;
      setSettingsStatus(data);
    } catch (e) {
      console.error("fetch settings failed:", e);
    }
  }, [authHeader]);

  useEffect(() => {
    fetchProviders();
    fetchTor();
    fetchSettings();
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(fetchLogs, 3000);
    const t2 = setInterval(fetchTor, 5000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, [auto, fetchLogs, fetchTor]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const stats = useMemo(() => {
    let s2 = 0,
      s4 = 0,
      s5 = 0,
      s3 = 0;
    const exitIps = new Set<string>();
    const providersSeen = new Set<string>();
    let viaTorCount = 0;
    for (const l of logs) {
      if (l.status >= 500) s5++;
      else if (l.status >= 400) s4++;
      else if (l.status >= 300) s3++;
      else if (l.status >= 200) s2++;
      if (l.exitIp && l.exitIp !== "—" && l.exitIp !== "unknown") {
        exitIps.add(l.exitIp);
      }
      if (l.provider && l.provider !== "—") providersSeen.add(l.provider);
      if (l.viaTor) viaTorCount++;
    }
    return {
      total: logs.length,
      s2,
      s3,
      s4,
      s5,
      distinctExitIps: exitIps.size,
      distinctProviders: providersSeen.size,
      viaTor: viaTorCount,
    };
  }, [logs]);

  const filtered = useMemo(() => {
    if (!query.trim()) return logs;
    const q = query.toLowerCase();
    return logs.filter((l) =>
      (
        l.method +
        " " +
        l.path +
        " " +
        (l.target || "") +
        " " +
        l.ip +
        " " +
        l.exitIp +
        " " +
        l.provider +
        " " +
        l.ua +
        " " +
        l.referer +
        " " +
        (l.error || "")
      ).toLowerCase().includes(q),
    );
  }, [logs, query]);

  const deleteOne = useCallback(
    async (id: string) => {
      const r = await fetch(`/api/logs/${id}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      if (r.ok) {
        toast.success("Entry deleted");
        fetchLogs();
      } else if (r.status === 401) {
        toast.error("Authentication required.");
      } else {
        toast.error("Delete failed");
      }
    },
    [fetchLogs, authHeader],
  );

  const clearAll = useCallback(async () => {
    if (!confirm("Clear ALL logged requests? This cannot be undone.")) return;
    const r = await fetch("/api/logs", {
      method: "DELETE",
      headers: authHeader(),
    });
    if (r.ok) {
      toast.success("All logs cleared");
      fetchLogs();
    } else if (r.status === 401) {
      toast.error("Authentication required.");
    } else {
      toast.error("Clear failed");
    }
  }, [fetchLogs, authHeader]);

  const probeTor = useCallback(async () => {
    toast.info("Spinning up a fresh Tor circuit…");
    try {
      const r = await fetch("/api/tor/test", {
        method: "POST",
        headers: authHeader(),
      });
      const data = await r.json();
      if (r.ok) {
        toast.success(
          `Exit IP: ${data.exitIp} · ${data.mock ? "mock" : "via Tor"} · ${data.ms}ms`,
        );
      } else {
        toast.error(`Probe failed: ${data.error || r.status}`);
      }
    } catch (e) {
      toast.error(`Probe error: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(fetchLogs, 250);
  }, [fetchLogs, authHeader]);

  const generateTraffic = useCallback(async () => {
    toast.info("Generating test traffic…");
    const calls: Promise<void>[] = [
      fetch("/api/health").then(() => {}),
      fetch(
        "/api/proxy?url=" + encodeURIComponent("https://api.ipify.org?format=json"),
        { headers: authHeader() },
      ).then(() => {}),
      fetch(
        "/api/proxy?url=" + encodeURIComponent("https://api.ipify.org?format=json"),
        { headers: authHeader() },
      ).then(() => {}),
      fetch(
        "/api/proxy?url=" + encodeURIComponent("https://example.com"),
        { headers: authHeader() },
      ).then(() => {}),
      fetch(
        "/api/proxy?url=" + encodeURIComponent("https://chat.z.ai"),
        { headers: authHeader() },
      ).then(() => {}),
      fetch("/api/proxy", { headers: authHeader() }).then(() => {}),
      fetch("/api/tor/test", {
        method: "POST",
        headers: authHeader(),
      }).then(() => {}),
      fetch(
        "/api/proxy?url=" + encodeURIComponent("https://api.ipify.org?format=json"),
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (test-ua)",
            Referer: "https://t.me/somebot",
            ...authHeader(),
          },
        },
      ).then(() => {}),
    ];
    await Promise.allSettled(calls);
    setTimeout(fetchLogs, 350);
    toast.success("Test traffic dispatched");
  }, [fetchLogs, authHeader]);

  const onSettingsChanged = useCallback(() => {
    fetchSettings();
    fetchLogs();
  }, [fetchSettings, fetchLogs]);

  // Determine whether to show the login overlay.
  const needsAuth =
    settingsStatus?.dashboardLocked === true &&
    settingsStatus?.authenticated === false;

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0e17] text-slate-100">
      {/* Animated background glow */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(900px 500px at 80% -10%, rgba(110,231,255,0.10), transparent), radial-gradient(700px 400px at -10% 110%, rgba(167,139,250,0.08), transparent)",
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#0a0e17]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 font-extrabold text-[#0a0e17] shadow-lg shadow-cyan-500/20">
              TR
            </div>
            <div>
              <h1 className="text-base font-bold leading-tight tracking-tight sm:text-lg">
                tor-relay · dashboard
              </h1>
              <p className="text-[11px] text-slate-400 sm:text-xs">
                fresh exit IP per request · last 1000 entries ·{" "}
                <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">
                  /api/proxy?url=
                </code>
              </p>
            </div>
          </div>

          {/* Nav tabs */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
            <NavTab
              active={view === "logs"}
              onClick={() => setView("logs")}
              icon={<Activity className="h-3.5 w-3.5" />}
              label="logs"
            />
            <NavTab
              active={view === "providers"}
              onClick={() => setView("providers")}
              icon={<Boxes className="h-3.5 w-3.5" />}
              label="providers"
            />
            <NavTab
              active={view === "tor"}
              onClick={() => setView("tor")}
              icon={<Network className="h-3.5 w-3.5" />}
              label="tor"
            />
            <NavTab
              active={view === "settings"}
              onClick={() => setView("settings")}
              icon={<SettingsIcon className="h-3.5 w-3.5" />}
              label="settings"
            />
          </div>

          <div className="hidden items-center gap-2 lg:flex">
            <StatChip
              icon={<Activity className="h-3 w-3" />}
              label="total"
              value={stats.total}
              color="text-slate-100"
            />
            <StatChip
              icon={<Shuffle className="h-3 w-3" />}
              label="exit IPs"
              value={stats.distinctExitIps}
              color="text-violet-300"
            />
            <StatChip
              icon={<CheckCircle2 className="h-3 w-3" />}
              label="2xx"
              value={stats.s2}
              color="text-emerald-300"
            />
            <StatChip
              icon={<Ban className="h-3 w-3" />}
              label="4xx"
              value={stats.s4}
              color="text-amber-300"
            />
            <StatChip
              icon={<Zap className="h-3 w-3" />}
              label="5xx"
              value={stats.s5}
              color="text-rose-300"
            />
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter by exit ip, target, provider…"
                className="w-[220px] border-slate-700 bg-slate-900/80 pl-9 text-sm placeholder:text-slate-500 sm:w-[260px]"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAuto((v) => !v)}
              className="border-slate-700 bg-slate-900/80 hover:bg-slate-800"
            >
              {auto ? (
                <>
                  <Pause className="mr-1.5 h-3.5 w-3.5" /> pause
                </>
              ) : (
                <>
                  <Play className="mr-1.5 h-3.5 w-3.5" /> resume
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={generateTraffic}
              className="border-slate-700 bg-slate-900/80 hover:bg-slate-800"
            >
              <Zap className="mr-1.5 h-3.5 w-3.5" /> test
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearAll}
              className="border-rose-500/30 bg-rose-500/5 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> clear
            </Button>
          </div>
        </div>

        {/* live ticker */}
        <div className="border-t border-slate-800/60 bg-slate-950/40">
          <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-4 py-1.5 text-[11px] text-slate-500 sm:px-6 lg:px-8">
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              {auto ? "live · polling 3s" : "paused"}
            </span>
            <span className="text-slate-700">|</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> {fmtTime(now)}
            </span>
            <span className="text-slate-700">|</span>
            <span className="flex items-center gap-1">
              <Network className="h-3 w-3" /> tor:{" "}
              <span className={torStateStyle[tor?.state || "stopped"]?.text || "text-slate-400"}>
                {tor?.state || "loading…"}
              </span>
              {tor?.mock && (
                <span className="ml-1 rounded bg-amber-500/15 px-1 text-[9px] text-amber-300">
                  mock
                </span>
              )}
            </span>
            <span className="text-slate-700 hidden sm:inline">|</span>
            <span className="hidden sm:flex items-center gap-1">
              <Server className="h-3 w-3" /> {tor?.socks || "127.0.0.1:9050"}
            </span>
            {settingsStatus && (
              <>
                <span className="text-slate-700 hidden md:inline">|</span>
                <span className="hidden md:flex items-center gap-1">
                  <Lock className="h-3 w-3" />
                  {settingsStatus.isOpenRelay
                    ? "open relay"
                    : settingsStatus.hasPassword
                      ? "password set"
                      : "env var"}
                  {settingsStatus.dashboardLocked && (
                    <span className="ml-1 rounded bg-fuchsia-500/15 px-1 text-[9px] text-fuchsia-300">
                      dashboard locked
                    </span>
                  )}
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="relative z-10 mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {needsAuth ? (
          <LoginView
            onLogin={async (pwd) => {
              try {
                const r = await fetch("/api/auth", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ password: pwd }),
                });
                const data = await r.json();
                if (r.ok && data.authenticated) {
                  setAuth(pwd);
                  await fetchSettings();
                  await fetchLogs();
                  toast.success("Authenticated");
                } else {
                  toast.error(data.error || "Login failed");
                }
              } catch (e) {
                toast.error(
                  `Login error: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }}
          />
        ) : view === "logs" ? (
          <LogsView
            loading={loading}
            filtered={filtered}
            query={query}
            deleteOne={deleteOne}
          />
        ) : view === "providers" ? (
          <ProvidersView providers={providers} />
        ) : view === "tor" ? (
          <TorView tor={tor} onProbe={probeTor} />
        ) : (
          <SettingsView
            status={settingsStatus}
            authHeader={authHeader}
            onChanged={onSettingsChanged}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="relative z-10 mt-auto border-t border-slate-800/60 bg-[#0a0e17]/80">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] text-slate-500 sm:px-6 lg:px-8">
          <span>
            tor-relay · Next.js 16 · fresh circuit per request ·{" "}
            <a
              href="https://github.com/Sexlovr/tor-relay"
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 underline-offset-2 hover:underline"
            >
              source
            </a>
          </span>
          <span>
            showing {filtered.length} of {logs.length} entries ·{" "}
            {stats.distinctExitIps} distinct exit IPs · {stats.viaTor} via Tor
          </span>
        </div>
      </footer>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Sub-views                                                                */
/* ----------------------------------------------------------------------- */

function LogsView({
  loading,
  filtered,
  query,
  deleteOne,
}: {
  loading: boolean;
  filtered: LogEntry[];
  query: string;
  deleteOne: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> loading logs…
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <Card className="border-dashed border-slate-800 bg-slate-900/40">
        <CardContent className="flex flex-col items-center gap-3 py-20 text-center">
          <div className="text-5xl opacity-30">∅</div>
          <div className="text-slate-400">
            {query ? "No entries match your filter." : "No requests logged yet."}
          </div>
          <div className="text-xs text-slate-600">
            {query ? (
              "Try clearing the filter or generating test traffic."
            ) : (
              <>
                Try{" "}
                <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-cyan-300">
                  curl &quot;/api/proxy?url=https://api.ipify.org&quot;
                </code>{" "}
                or hit the{" "}
                <span className="text-cyan-300">test</span> button above.
              </>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {filtered.map((l) => (
        <Card
          key={l.id}
          className="border-slate-800/80 bg-slate-900/60 transition-colors hover:border-slate-700"
        >
          <CardContent className="p-3 sm:p-4">
            {/* BUG FIX (v2): mobile uses a flex column layout, sm+ uses the grid */}
            <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[auto_auto_1fr_auto_auto_auto_auto] sm:items-center sm:gap-3 lg:gap-4">
              {/* timestamp */}
              <div className="font-mono text-[11px] text-slate-500 sm:text-xs">
                {fmtTime(l.ts)}
              </div>

              {/* method */}
              <Badge
                variant="outline"
                className={`h-6 min-w-[50px] justify-center border font-mono text-[10px] font-bold ${methodColor[l.method] || "bg-slate-700/40 text-slate-300 border-slate-600"}`}
              >
                {l.method}
              </Badge>

              {/* path + target */}
              <div className="min-w-0">
                <div className="truncate font-mono text-xs text-slate-200">
                  {l.path}
                </div>
                {l.target && (
                  <div className="mt-0.5 flex items-center gap-1 truncate font-mono text-[11px] text-cyan-300/80">
                    <ArrowRight className="h-3 w-3 shrink-0" />
                    <span className="truncate">{l.target}</span>
                  </div>
                )}
              </div>

              {/* EXIT IP -- the new feature */}
              <div className="flex flex-col items-end gap-0.5">
                <div className="flex items-center gap-1.5 font-mono text-xs font-bold text-violet-300">
                  <Wifi className="h-3 w-3" />
                  {l.exitIp}
                </div>
                {l.viaTor ? (
                  <Badge
                    variant="outline"
                    className="h-4 border-violet-500/40 bg-violet-500/10 px-1 font-mono text-[9px] text-violet-300"
                  >
                    via tor
                  </Badge>
                ) : l.exitIp !== "—" ? (
                  <Badge
                    variant="outline"
                    className="h-4 border-slate-700 bg-slate-800/60 px-1 font-mono text-[9px] text-slate-400"
                  >
                    direct
                  </Badge>
                ) : null}
              </div>

              {/* provider badge — hidden on mobile to save space */}
              <Badge
                variant="outline"
                className={`hidden h-6 justify-center border font-mono text-[10px] font-semibold sm:flex ${providerColor[l.provider] || providerColor.unknown}`}
              >
                {providerLabel[l.provider] || l.provider}
              </Badge>

              {/* status */}
              <div
                className={`text-center font-mono text-sm font-bold ${statusClass(l.status)}`}
              >
                {l.status}
              </div>

              {/* delete */}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                onClick={() => deleteOne(l.id)}
                title="delete entry"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* meta row */}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-800/60 pt-2 text-[11px] text-slate-500">
              {/* on mobile show the provider here */}
              <span className="sm:hidden">
                <span className="text-slate-600">provider</span>{" "}
                <Badge
                  variant="outline"
                  className={`h-4 border px-1 font-mono text-[9px] ${providerColor[l.provider] || providerColor.unknown}`}
                >
                  {providerLabel[l.provider] || l.provider}
                </Badge>
              </span>
              <span>
                <span className="text-slate-600">duration</span>{" "}
                <span className="text-slate-300">
                  {l.durationMs != null ? fmtDuration(l.durationMs) : "?"}
                </span>
              </span>
              <span>
                <span className="text-slate-600">bytes</span>{" "}
                <span className="text-slate-300">{fmtBytes(l.bytes)}</span>
              </span>
              <span>
                <span className="text-slate-600">src</span>{" "}
                <span className="text-slate-300">{l.ip}</span>
              </span>
              <span className="min-w-0">
                <span className="text-slate-600">ua</span>{" "}
                <span className="text-slate-300">{l.ua || "–"}</span>
              </span>
              <span className="min-w-0">
                <span className="text-slate-600">referer</span>{" "}
                <span className="text-slate-300">{l.referer || "–"}</span>
              </span>
              {l.error && (
                <span>
                  <span className="text-slate-600">error</span>{" "}
                  <span className="text-rose-300">{l.error}</span>
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ProvidersView({ providers }: { providers: ProviderInfo[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {providers.map((p) => (
        <Card
          key={p.id}
          className="border-slate-800/80 bg-slate-900/60 transition-colors hover:border-slate-700"
        >
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={`h-6 border font-mono text-[10px] font-semibold ${p.color}`}
                >
                  {p.name}
                </Badge>
                <span className="font-mono text-[10px] text-slate-500">
                  {p.id}
                </span>
              </div>
              <span className="text-[10px] text-slate-500">
                {p.hostCount} host{p.hostCount === 1 ? "" : "s"}
              </span>
            </div>
            <CardTitle className="pt-1 text-sm text-slate-300">
              {p.description}
            </CardTitle>
          </CardHeader>
          <Separator className="bg-slate-800/80" />
          <CardContent className="pt-3">
            <ul className="flex flex-col gap-1.5">
              {p.hosts.map((h) => (
                <li
                  key={h}
                  className="flex items-center gap-2 font-mono text-[11px] text-slate-300"
                >
                  <Globe className="h-3 w-3 text-slate-500" />
                  <span className="truncate">{h}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TorView({
  tor,
  onProbe,
}: {
  tor: TorStatus | null;
  onProbe: () => void;
}) {
  const s = torStateStyle[tor?.state || "stopped"] || torStateStyle.stopped;
  return (
    <div className="flex flex-col gap-3">
      <Card className="border-slate-800/80 bg-slate-900/60">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-violet-500/30 to-cyan-500/20">
                <Network className="h-5 w-5 text-violet-300" />
              </div>
              <div>
                <CardTitle className="text-sm">tor supervisor</CardTitle>
                <p className="text-[11px] text-slate-500">
                  binary:{" "}
                  <code className="text-slate-300">{tor?.binary || "—"}</code>{" "}
                  · socks:{" "}
                  <code className="text-slate-300">{tor?.socks || "—"}</code>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={`h-7 border font-mono text-[11px] font-bold ${s.border} ${s.bg} ${s.text}`}
              >
                {tor?.state || "loading…"}
              </Badge>
              {tor?.mock && (
                <Badge
                  variant="outline"
                  className="h-7 border-amber-500/40 bg-amber-500/10 font-mono text-[11px] text-amber-300"
                >
                  mock mode
                </Badge>
              )}
              <Button
                size="sm"
                onClick={onProbe}
                className="bg-gradient-to-br from-violet-500 to-cyan-500 text-white hover:opacity-90"
              >
                <Shuffle className="mr-1.5 h-3.5 w-3.5" /> probe fresh circuit
              </Button>
            </div>
          </div>
        </CardHeader>
        <Separator className="bg-slate-800/80" />
        <CardContent className="pt-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="pid" value={tor?.pid?.toString() || "—"} />
            <Metric
              label="uptime"
              value={
                tor?.uptime_s != null
                  ? tor.uptime_s > 60
                    ? `${Math.floor(tor.uptime_s / 60)}m ${tor.uptime_s % 60}s`
                    : `${tor.uptime_s}s`
                  : "—"
              }
            />
            <Metric label="restarts" value={(tor?.restarts ?? 0).toString()} />
            <Metric label="binary" value={tor?.binary || "—"} mono />
          </div>
        </CardContent>
      </Card>

      <Card className="border-slate-800/80 bg-slate-900/60">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-cyan-300" />
            <CardTitle className="text-sm">recent tor output</CardTitle>
          </div>
        </CardHeader>
        <Separator className="bg-slate-800/80" />
        <CardContent className="pt-4">
          <ScrollArea className="max-h-72">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-slate-400">
              {tor?.recent_log && tor.recent_log.length > 0
                ? tor.recent_log.join("\n")
                : "(no output yet — tor hasn't logged anything)"}
            </pre>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function SettingsView({
  status,
  authHeader,
  onChanged,
}: {
  status: SettingsStatus | null;
  authHeader: () => HeadersInit;
  onChanged: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  if (!status) {
    return (
      <div className="flex h-[40vh] items-center justify-center text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> loading settings…
      </div>
    );
  }

  const isFirstRun = !status.hasPassword && !status.envFallback;
  const canSubmit =
    next.length >= 4 && next === confirm && (!status.hasPassword || current.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const r = await fetch("/api/settings/password", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify({ current: current || undefined, next }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        toast.success(
          isFirstRun ? "Password set — relay is now protected." : "Password updated.",
        );
        setCurrent("");
        setNext("");
        setConfirm("");
        onChanged();
      } else {
        toast.error(data.error || "Failed to set password.");
      }
    } catch (e) {
      toast.error(
        `Error: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const clearPwd = async () => {
    if (!current) {
      toast.error("Enter the current password to clear it.");
      return;
    }
    if (!confirm("Clear the stored password? The relay will fall back to env var or open mode.")) return;
    setBusy(true);
    try {
      const r = await fetch("/api/settings/clear", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify({ current }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        toast.success("Password cleared.");
        setCurrent("");
        onChanged();
      } else {
        toast.error(data.error || "Failed to clear password.");
      }
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = async () => {
    if (!current && status.hasPassword) {
      toast.error("Enter the current password to toggle the dashboard lock.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/settings/lock", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify({
          locked: !status.dashboardLocked,
          current: current || undefined,
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        toast.success(
          data.locked ? "Dashboard locked — auth required to view." : "Dashboard unlocked.",
        );
        setCurrent("");
        onChanged();
      } else {
        toast.error(data.error || "Failed to toggle lock.");
      }
    } catch (e) {
      toast.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Status card */}
      <Card className="border-slate-800/80 bg-slate-900/60">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-cyan-300" />
            <CardTitle className="text-sm">authentication status</CardTitle>
          </div>
        </CardHeader>
        <Separator className="bg-slate-800/80" />
        <CardContent className="pt-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label="relay mode"
              value={
                status.isOpenRelay
                  ? "open"
                  : status.hasPassword
                    ? "password"
                    : "env var"
              }
            />
            <Metric
              label="password set"
              value={status.hasPassword ? "yes" : "no"}
            />
            <Metric
              label="dashboard"
              value={status.dashboardLocked ? "locked" : "open"}
            />
            <Metric
              label="env fallback"
              value={status.envFallback ? "yes" : "no"}
            />
          </div>
          {status.setupAt && (
            <p className="mt-3 text-[11px] text-slate-500">
              Password set at:{" "}
              <code className="text-slate-300">{fmtDate(status.setupAt)}</code>
            </p>
          )}
          {isFirstRun && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
              ⚠ No password is set — the relay is currently open. Set a password
              below to protect it.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Password form */}
      <Card className="border-slate-800/80 bg-slate-900/60">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-violet-300" />
            <CardTitle className="text-sm">
              {isFirstRun
                ? "set initial password"
                : status.hasPassword
                  ? "change password"
                  : "set password"}
            </CardTitle>
          </div>
        </CardHeader>
        <Separator className="bg-slate-800/80" />
        <CardContent className="pt-4">
          <div className="flex flex-col gap-3">
            {status.hasPassword && (
              <PasswordInput
                label="current password"
                value={current}
                onChange={setCurrent}
                show={showCurrent}
                onToggleShow={() => setShowCurrent((v) => !v)}
              />
            )}
            <PasswordInput
              label="new password"
              value={next}
              onChange={setNext}
              show={showNext}
              onToggleShow={() => setShowNext((v) => !v)}
              hint="at least 4 characters"
            />
            <PasswordInput
              label="confirm new password"
              value={confirm}
              onChange={setConfirm}
              show={showConfirm}
              onToggleShow={() => setShowConfirm((v) => !v)}
              error={
                confirm && next !== confirm
                  ? "passwords don't match"
                  : undefined
              }
            />
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button
                onClick={submit}
                disabled={!canSubmit || busy}
                className="bg-gradient-to-br from-violet-500 to-cyan-500 text-white hover:opacity-90"
              >
                {busy ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                )}
                {isFirstRun ? "set password" : "update password"}
              </Button>
              {status.hasPassword && (
                <Button
                  variant="outline"
                  onClick={clearPwd}
                  disabled={busy || !current}
                  className="border-rose-500/30 bg-rose-500/5 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" /> clear password
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Dashboard lock toggle */}
      <Card className="border-slate-800/80 bg-slate-900/60">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            {status.dashboardLocked ? (
              <Lock className="h-4 w-4 text-fuchsia-300" />
            ) : (
              <Unlock className="h-4 w-4 text-emerald-300" />
            )}
            <CardTitle className="text-sm">dashboard lock</CardTitle>
          </div>
        </CardHeader>
        <Separator className="bg-slate-800/80" />
        <CardContent className="pt-4">
          <p className="text-[12px] text-slate-400">
            When locked, viewing logs / settings / tor requires the relay
            password. The proxy endpoint is always password-protected (when a
            password is set); this only controls the dashboard UI.
          </p>
          <div className="mt-3">
            <Button
              variant="outline"
              onClick={toggleLock}
              disabled={busy || (!status.hasPassword && !status.envFallback)}
              className={
                status.dashboardLocked
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300 hover:bg-emerald-500/10"
                  : "border-fuchsia-500/30 bg-fuchsia-500/5 text-fuchsia-300 hover:bg-fuchsia-500/10"
              }
            >
              {status.dashboardLocked ? (
                <>
                  <Unlock className="mr-1.5 h-3.5 w-3.5" /> unlock dashboard
                </>
              ) : (
                <>
                  <Lock className="mr-1.5 h-3.5 w-3.5" /> lock dashboard
                </>
              )}
            </Button>
            {!status.hasPassword && !status.envFallback && (
              <p className="mt-2 text-[11px] text-amber-300">
                Set a password first — locking the dashboard without a password
                has no effect.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LoginView({ onLogin }: { onLogin: (pwd: string) => void | Promise<void> }) {
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  return (
    <Card className="mx-auto max-w-md border-slate-800 bg-slate-900/60">
      <CardContent className="flex flex-col gap-4 py-10">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500/30 to-violet-500/20">
            <Lock className="h-7 w-7 text-fuchsia-300" />
          </div>
          <h2 className="text-lg font-bold text-slate-100">dashboard locked</h2>
          <p className="text-[12px] text-slate-400">
            This tor-relay dashboard requires the proxy password. Enter it
            below to view logs, providers, tor status, and settings.
          </p>
        </div>
        <div className="relative">
          <Input
            type={show ? "text" : "password"}
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="relay password"
            className="border-slate-700 bg-slate-900/80 pr-9 font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter" && pwd && !busy) {
                setBusy(true);
                Promise.resolve(onLogin(pwd)).finally(() => setBusy(false));
              }
            }}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
            title={show ? "hide" : "show"}
          >
            {show ? "🙈" : "👁"}
          </button>
        </div>
        <Button
          onClick={() => {
            if (!pwd || busy) return;
            setBusy(true);
            Promise.resolve(onLogin(pwd)).finally(() => setBusy(false));
          }}
          disabled={!pwd || busy}
          className="bg-gradient-to-br from-fuchsia-500 to-violet-500 text-white hover:opacity-90"
        >
          {busy ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="mr-1.5 h-4 w-4" />
          )}
          unlock
        </Button>
      </CardContent>
    </Card>
  );
}

/* ----------------------------------------------------------------------- */
/* Small components                                                         */
/* ----------------------------------------------------------------------- */

function NavTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-slate-800 text-cyan-300"
          : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function StatChip({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5">
      <span className={color}>{icon}</span>
      <div className="leading-none">
        <div className="text-[9px] uppercase tracking-wider text-slate-500">
          {label}
        </div>
        <div className={`text-base font-bold ${color}`}>{value}</div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div
        className={`mt-0.5 text-sm text-slate-200 ${mono ? "font-mono" : "font-semibold"}`}
      >
        {value}
      </div>
    </div>
  );
}

function PasswordInput({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  hint?: string;
  error?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-slate-500">
        {label}
      </span>
      <div className="relative">
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`bg-slate-900/80 pr-9 font-mono ${
            error
              ? "border-rose-500/50"
              : "border-slate-700"
          }`}
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
          title={show ? "hide" : "show"}
        >
          {show ? "🙈" : "👁"}
        </button>
      </div>
      {error ? (
        <span className="text-[11px] text-rose-300">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-slate-600">{hint}</span>
      ) : null}
    </label>
  );
}
