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
 */

import { spawn, ChildProcess, execFile } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { SocksProxyAgent } from "socks-proxy-agent";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TOR_BIN = process.env.TOR_BIN || "tor";
const TOR_SOCKS = process.env.TOR_SOCKS || "127.0.0.1:9050";
const TOR_DATA =
  process.env.TOR_DATA || path.join(os.tmpdir(), "tor-relay-data");

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

  /** Parse TOR_SOCKS "host:port" → ["host", port]. */
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
          setTimeout(() => this.start(true), 5000);
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

  private async awaitReady(deadlineSeconds = 180) {
    const deadline = Date.now() + deadlineSeconds * 1000;
    // Phase 1: wait for SOCKS port to be bound.
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

  /** Periodic background poll — if tor was "starting" but SOCKS is now
   *  actually accepting connections, flip to "ready". Also catches the case
   *  where tor exits and the SOCKS port goes down — flips back to "exited". */
  private startStatePoller() {
    setInterval(async () => {
      if (this._state === "binary-missing") return;
      if (this._state === "ready") {
        // Verify still alive
        if (this.proc && this.proc.exitCode !== null) {
          this._state = "exited";
        }
        return;
      }
      if (this._state === "starting" || this._state === "exited") {
        if (await this.isSocksReady()) {
          this._state = "ready";
          this.log("tor SOCKS is up -- per-request circuits will get fresh exit IPs");
        }
      }
    }, 5000).unref?.();
  }

  /** Kick off the supervisor. Idempotent. */
  start(force = false) {
    if (this.started && !force) return;
    this.started = true;
    this.startStatePoller();

    // Probe whether tor binary is on PATH or at TOR_BIN. If not, surface
    // a clear error in the dashboard — no silent fallback.
    execFile("which", [TOR_BIN], (err, stdout) => {
      const onPath = !err && stdout.trim().length > 0;
      const absoluteExists = path.isAbsolute(TOR_BIN) && require_fs_exists(TOR_BIN);
      if (!onPath && !absoluteExists) {
        this._state = "binary-missing";
        this.log(
          `tor binary not found at "${TOR_BIN}". Install tor (apt-get install tor) or set TOR_BIN=/path/to/tor.`,
        );
        return;
      }
      this._state = "starting";
      this.startedAt = Date.now();
      this.log(`launching tor binary: ${TOR_BIN}`);
      this.spawnTor();
      void this.awaitReady();
    });
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
      socks: TOR_SOCKS,
      data_dir: TOR_DATA,
      pid: this.proc?.pid ?? null,
      uptime_s: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      restarts: this.restartCount,
      recent_log: this.recentLog(),
    };
  }
}

/** Synchronous fs.existsSync shim — kept outside the class so it doesn't
 *  leak into the JSON status output. */
function require_fs_exists(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsSync = require("node:fs");
    return fsSync.existsSync(p);
  } catch {
    return false;
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
