/**
 * Tor supervisor + per-request SOCKS routing helpers for tor-relay.
 *
 * Direct port of the TorSupervisor from the original python app.py:
 *   - spawns the tor binary as a child process (kept alive by THIS process,
 *     not by a shell script — important on Render / Docker where PID 1
 *     reaps orphan shell-started daemons),
 *   - waits for SOCKS readiness on TOR_SOCKS (default 127.0.0.1:9050),
 *   - restarts on death,
 *   - keeps a 60-line ring buffer of the last tor output for /api/tor.
 *
 * Per-request exit-IP isolation:
 *   Each request builds a SOCKS5h agent with a fresh random username.
 *   On Tor, a distinct username:password on the SOCKS port is a distinct
 *   circuit (= a distinct exit IP), so every request leaves from a new IP.
 *   No mock mode, no fallback, no direct routing — every proxied byte
 *   goes through Tor.
 *
 * TOR BIN PATH — hardcoded, not env-driven:
 *   We try a list of known-good install locations in order:
 *     1. /usr/bin/tor           (apt-get install tor / Dockerfile)
 *     2. /usr/local/bin/tor    (brew install tor on linux, manual builds)
 *     3. /home/z/.local/bin/tor (user-mode install on this sandbox)
 *     4. /home/z/.local/usr/bin/tor  (extracted .deb user-mode)
 *   If none exists, state -> "binary-missing" and the dashboard surfaces
 *   a clear error.
 */

import { spawn, ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { SocksProxyAgent } from "socks-proxy-agent";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";

/** Hardcoded list of tor binary locations to try, in order. */
const TOR_BIN_CANDIDATES = [
  "/usr/bin/tor",
  "/usr/local/bin/tor",
  "/home/z/.local/bin/tor",
  "/home/z/.local/usr/bin/tor",
];

/** Pick the first tor binary that actually exists on disk. */
function resolveTorBinary(): string {
  for (const p of TOR_BIN_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  // Fall back to bare "tor" — will rely on PATH lookup. The supervisor
  // will surface a "binary-missing" state if even that isn't found.
  return "tor";
}

const TOR_BIN = resolveTorBinary();
const TOR_SOCKS = "127.0.0.1:9050";
const TOR_DATA = "/home/z/tor-data";

const MAX_LOG_LINES = 60;

type TorState =
  | "stopped"
  | "starting"
  | "ready"
  | "binary-missing"
  | "timeout"
  | "exited";

class TorSupervisor {
  private proc: ChildProcess | null = null;
  private _state: TorState = "stopped";
  private startedAt: number | null = null;
  private restartCount = 0;
  private readonly logLines: string[] = [];
  private started = false;
  private pollerStarted = false;

  get state(): TorState {
    return this._state;
  }

  private log(line: string) {
    const ts = new Date().toISOString().slice(11, 19);
    const entry = `[${ts}] ${line}`;
    this.logLines.push(entry);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    console.log("[tor]", line);
  }

  recentLog(): string[] {
    return [...this.logLines];
  }

  /** Parse "host:port" → ["host", port]. */
  private socksHostPort(): [string, number] {
    const [h, p] = TOR_SOCKS.split(":");
    return [h || "127.0.0.1", Number(p || 9050)];
  }

  private async isSocksReady(): Promise<boolean> {
    const [host, port] = this.socksHostPort();
    return new Promise((resolve) => {
      const sock = createConnection({ host, port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1500, () => {
        sock.destroy();
        resolve(false);
      });
    });
  }

  private async writeTorrc(): Promise<string> {
    const [host, port] = this.socksHostPort();
    await fs.mkdir(TOR_DATA, { recursive: true });
    const torrc = path.join(TOR_DATA, "torrc");
    const body = [
      `SocksPort ${host}:${port}`,
      `DataDirectory ${TOR_DATA}`,
      "Log notice stdout",
      "SafeLogging 1",
      // Make tor aggressive about giving us fresh circuits per SOCKS user.
      // SOCKS5 username isolation is ON by default in modern tor — a distinct
      // username:password on the SOCKS port gets its own circuit (own exit IP).
      "CircuitBuildTimeout 15",
      "LearnCircuitBuildTimeout 1",
      "NewCircuitPeriod 10",
      "MaxCircuitDirtiness 10",
      "",
    ].join("\n");
    await fs.writeFile(torrc, body, "utf8");
    return torrc;
  }

  private spawnTor() {
    void this.writeTorrc()
      .then((torrc) => {
        const child = spawn(TOR_BIN, ["-f", torrc], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.proc = child;

        const onLine = (buf: Buffer) => {
          for (const raw of buf.toString("utf8").split(/\r?\n/)) {
            const line = raw.trim();
            if (line) this.log(line);
          }
        };
        child.stdout?.on("data", onLine);
        child.stderr?.on("data", onLine);

        child.on("exit", (code, signal) => {
          this.log(`tor exited code=${code} signal=${signal} -- restarting in 5s`);
          this._state = "exited";
          this.restartCount++;
          // schedule restart WITHOUT re-adding the state poller
          setTimeout(() => this.spawnTorAndAwait(), 5000);
        });
        child.on("error", (err) => {
          this.log(`tor spawn error: ${err.message}`);
          this._state = "binary-missing";
        });
      })
      .catch((err) => {
        this.log(`torrc write failed: ${err.message}`);
        this._state = "binary-missing";
      });
  }

  /** Spawn tor and wait for SOCKS readiness. Used by both initial start and
   *  the auto-restart loop (so we don't go through the start() guard). */
  private spawnTorAndAwait() {
    if (this._state === "binary-missing") return;
    this._state = "starting";
    this.startedAt = Date.now();
    this.log(`launching tor binary: ${TOR_BIN}`);
    this.spawnTor();
    void this.awaitReady();
  }

  private async awaitReady(deadlineSeconds = 180) {
    const deadline = Date.now() + deadlineSeconds * 1000;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        // exited; the exit handler will restart
        return;
      }
      if (await this.isSocksReady()) {
        this._state = "ready";
        this.log("tor SOCKS is up -- per-request circuits will get fresh exit IPs");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this._state = "timeout";
    this.log("timeout waiting for tor SOCKS readiness");
  }

  /**
   * Periodic background poll. Created EXACTLY ONCE — the auto-restart loop
   * calls spawnTorAndAwait(), not start(), so this poller is never
   * re-instantiated. Without this guarantee we'd stack up multiple
   * intervals and spam "tor SOCKS is up" every restart cycle.
   *
   * The poller's job:
   *   - if state is "starting" or "exited" and SOCKS port is now open,
   *     flip to "ready" + log it (catches the case where awaitReady's
   *     poll loop fired before tor bound the port, or where tor rebound
   *     after an exit)
   *   - if state is "ready" but proc has exited, flip to "exited" (so
   *     the dashboard shows the truth)
   *   - if state is "binary-missing", do nothing
   */
  private startStatePollerOnce() {
    if (this.pollerStarted) return;
    this.pollerStarted = true;
    const h = setInterval(async () => {
      if (this._state === "binary-missing") return;
      if (this._state === "ready") {
        if (this.proc && this.proc.exitCode !== null) {
          this._state = "exited";
          this.log("tor process exited unexpectedly (will restart via exit handler)");
        }
        return;
      }
      if (this._state === "starting" || this._state === "exited") {
        if (await this.isSocksReady()) {
          this._state = "ready";
          this.log("tor SOCKS is up -- per-request circuits will get fresh exit IPs");
        }
      }
    }, 5000);
    // Don't keep the event loop alive just for this poller.
    h.unref?.();
  }

  /** Kick off the supervisor. Idempotent — calling multiple times is safe. */
  start() {
    if (this.started) return;
    this.started = true;
    this.startStatePollerOnce();

    if (!existsSync(TOR_BIN)) {
      this._state = "binary-missing";
      this.log(
        `tor binary not found at any of: ${TOR_BIN_CANDIDATES.join(", ")}. ` +
          `Install tor (apt-get install tor) and restart the app.`,
      );
      return;
    }

    this.spawnTorAndAwait();
  }

  /**
   * Returns a per-request SOCKS agent.
   *
   * Every call uses a fresh random SOCKS username:password — on Tor that's
   * a distinct circuit (= a distinct exit IP). This is the per-request
   * rotation property the original python relay relies on.
   *
   * URI format: socks5h://<user>:<pass>@<host>:<port>
   *   - socks5h means SOCKS5 with hostname resolution at the proxy (the
   *     tor exit resolves DNS, not us — correct for a tor relay).
   *   - encodeURIComponent handles any odd chars in the random uuid.
   *
   * If tor isn't ready yet (state != "ready"), we still return an agent —
   * the request will fail with a connection error and the proxy route logs
   * that as a 502. No silent fallback to direct routing.
   */
  newAgent(): {
    agent: SocksProxyAgent;
    circuit: string;
    proxyUri: string;
  } {
    const user = "tor-relay-" + randomUUID().slice(0, 8);
    const pass = randomUUID().slice(0, 12);
    const [host, port] = this.socksHostPort();
    const proxyUri = `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    const agent = new SocksProxyAgent(proxyUri);
    return { agent, circuit: user, proxyUri };
  }

  status() {
    return {
      state: this._state,
      binary: TOR_BIN,
      binary_candidates: TOR_BIN_CANDIDATES,
      socks: TOR_SOCKS,
      data_dir: TOR_DATA,
      pid: this.proc?.pid ?? null,
      uptime_s: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      restarts: this.restartCount,
      recent_log: this.recentLog(),
    };
  }
}

const supervisor = new TorSupervisor();
// Defer the actual spawn to the first request so serverless cold starts don't
// get billed for tor boot time when nobody is using the proxy. The dashboard
// calls /api/tor which triggers start().
let bootPromise: Promise<void> | null = null;
export function ensureTorBooted(): Promise<void> {
  if (!bootPromise) {
    bootPromise = new Promise((resolve) => {
      supervisor.start();
      resolve();
    });
  }
  return bootPromise;
}

export { supervisor };
