/**
 * Tor supervisor + SOCKS routing helpers for tor-relay.
 *
 * Mirrors the TorSupervisor in the original python app.py:
 *   - spawns the tor binary in a child process,
 *   - waits for SOCKS readiness on TOR_SOCKS (default 127.0.0.1:9050),
 *   - restarts on death,
 *   - keeps a ring buffer of the last N output lines for /api/tor.
 *
 * The big addition over the python version: every outbound request builds a
 * SOCKS agent with a fresh random SOCKS username -- on Tor that means a fresh
 * circuit (= a fresh exit IP) per request.
 *
 * If the tor binary is not present (e.g. in the sandbox preview) the
 * supervisor flips into "mock" mode: the proxy still works but routes
 * directly, and the exit IP is the machine's own public IP (so the dashboard
 * is still demonstrable).
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
const TOR_MOCK = process.env.TOR_MOCK === "1" || process.env.TOR_MOCK === "true";
const TOR_DISABLED =
  process.env.TOR_DISABLED === "1" ||
  process.env.TOR_DISABLED === "true" ||
  TOR_MOCK;

const MAX_LOG_LINES = 60;

type TorState =
  | "stopped"
  | "starting"
  | "ready"
  | "mock"
  | "disabled"
  | "binary-missing"
  | "timeout"
  | "exited";

class TorSupervisor {
  private proc: ChildProcess | null = null;
  private _state: TorState = "stopped";
  private startedAt: number | null = null;
  private restartCount = 0;
  private readonly logLines: string[] = [];
  private mockExitIpPool: string[] = [];
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

  private async awaitReady(deadlineSeconds = 90) {
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

  /** Kick off the supervisor. Idempotent. */
  start(force = false) {
    if (this.started && !force) return;
    this.started = true;

    if (TOR_DISABLED) {
      this._state = TOR_MOCK ? "mock" : "disabled";
      this.log(
        TOR_MOCK
          ? "tor disabled via TOR_MOCK=1 — proxy will go direct, exit IPs simulated"
          : "tor disabled via TOR_DISABLED=1 — proxy will go direct",
      );
      this.mockExitIpPool = this.generateMockExitPool();
      return;
    }

    // Probe whether tor binary is on PATH. If not, switch to mock mode so the
    // dashboard is still usable in environments without tor installed.
    execFile("which", [TOR_BIN], (err, stdout) => {
      if (err || !stdout.trim()) {
        this.log(`tor binary not found (${TOR_BIN}) -- falling back to mock mode`);
        this._state = "mock";
        this.mockExitIpPool = this.generateMockExitPool();
        return;
      }
      this._state = "starting";
      this.startedAt = Date.now();
      this.log(`launching tor binary: ${TOR_BIN}`);
      this.spawnTor();
      void this.awaitReady();
    });
  }

  private generateMockExitPool(): string[] {
    // A small rotating pool of plausible exit IPs for mock-mode demos.
    return [
      "185.220.101.1",
      "185.220.101.2",
      "171.25.193.78",
      "23.129.64.130",
      "199.249.230.105",
      "89.39.106.10",
      "51.158.144.32",
      "176.10.99.200",
    ];
  }

  /**
   * Returns a per-request SOCKS agent.
   *
   * Each call uses a fresh random SOCKS username -- Tor treats a distinct
   * username:password on the SOCKS port as a distinct circuit, i.e. a
   * distinct exit IP. So this gives us the "fresh exit IP per request"
   * property that the original python relay relies on.
   *
   * BUG FIX (v2): the SocksProxyAgent constructor takes a URI string
   * `socks5h://user:pass@host:port`, NOT an options object. The old code
   * passed `{ host, port, type, userId, password }` which silently threw.
   *
   * In mock / disabled mode, returns `undefined` so callers fall back to a
   * direct fetch. The caller can still probe the machine's actual public IP.
   */
  newAgent(): {
    agent: SocksProxyAgent | undefined;
    circuit: string;
    mock: boolean;
    proxyUri: string;
  } {
    const user = "tor-relay-" + randomUUID().slice(0, 8);
    const pass = randomUUID().slice(0, 12);
    const [host, port] = this.socksHostPort();

    if (this._state === "mock" || this._state === "disabled") {
      return { agent: undefined, circuit: user, mock: true, proxyUri: "" };
    }

    // NOTE: socks5h means SOCKS5 with hostname resolution at the proxy
    // (so the tor exit resolves DNS, not us). This is the correct mode for
    // a tor relay.
    const proxyUri = `socks5h://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    const agent = new SocksProxyAgent(proxyUri);
    return { agent, circuit: user, mock: false, proxyUri };
  }

  /** Pop a plausible mock exit IP for mock-mode entries. */
  popMockExitIp(): string {
    if (this.mockExitIpPool.length === 0) {
      this.mockExitIpPool = this.generateMockExitPool();
    }
    // rotate
    const idx = Math.floor(Math.random() * this.mockExitIpPool.length);
    const ip = this.mockExitIpPool[idx];
    // move to end so a streak doesn't repeat the same IP
    this.mockExitIpPool.splice(idx, 1);
    this.mockExitIpPool.push(ip);
    return ip;
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
      mock: this._state === "mock",
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
      // Resolve immediately; readiness is reported via /api/tor polling.
      resolve();
    });
  }
  return bootPromise;
}

export { supervisor };
