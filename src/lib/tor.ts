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
 * BINARY DISCOVERY:
 *   1. Check hardcoded candidates (system-installed tor)
 *   2. If none exists, DOWNLOAD the tor .deb from debian.org and extract
 *      it into the app's data directory at first boot. This way the app
 *      is self-bootstrapping — works on fresh sandboxes / Vercel-like
 *      platforms / Docker images without tor pre-installed.
 */

import { spawn, ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { SocksProxyAgent } from "socks-proxy-agent";
import { promises as fs, existsSync, createWriteStream } from "node:fs";
import path from "node:path";
import https from "node:https";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

/** Where the app stores tor's data dir + the downloaded/extracted binary. */
const TOR_DATA = "/home/z/tor-data";
/** Where the downloaded .deb is extracted to. */
const LOCAL_TOR_PREFIX = path.join(TOR_DATA, "extracted");
/** Where the tor binary lives after extraction. */
const LOCAL_TOR_BIN = path.join(LOCAL_TOR_PREFIX, "usr", "bin", "tor");

/** Hardcoded list of tor binary locations to try, in order. */
function torBinCandidates(): string[] {
  return [
    "/usr/bin/tor", // apt-get install tor / Dockerfile
    "/usr/local/bin/tor", // brew / manual build
    "/home/z/.local/bin/tor", // user-mode install on dev sandbox
    "/home/z/.local/usr/bin/tor",
    LOCAL_TOR_BIN, // downloaded at runtime by ensureTorBinary()
  ];
}

/**
 * Pick the first tor binary that actually exists on disk.
 * Returns the absolute path, or null if none exists yet.
 */
function findExistingTorBinary(): string | null {
  for (const p of torBinCandidates()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Map process.arch to the Debian tor package arch suffix. */
function debArch(): string {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    case "arm":
      return "armhf";
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`);
  }
}

/**
 * Download a URL to a local file. Returns the local file path.
 *
 * Uses node:https directly (not fetch) so it works in plain Node without
 * depending on undici's quirks. Streams to disk so even big files don't
 * buffer in memory.
 */
function downloadToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const get = (u: string, redirectsLeft: number) => {
      const req = https.get(
        u,
        {
          // Some Debian mirrors want a user-agent
          headers: { "User-Agent": "tor-relay-installer/1.0" },
          timeout: 60_000,
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (redirectsLeft <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            res.destroy();
            const next = new URL(
              res.headers.location,
              u,
            ).toString();
            get(next, redirectsLeft - 1);
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                `HTTP ${res.statusCode} downloading ${u}`,
              ),
            );
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
          file.on("error", (err) => reject(err));
        },
      );
      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy(new Error("download timeout"));
      });
    };
    get(url, 5);
  });
}

/**
 * Find the current Debian tor .deb URL by parsing the pool index.
 *
 * We can't hardcode the version (it changes). Instead, fetch the directory
 * listing at https://deb.debian.org/debian/pool/main/t/tor/ and pick the
 * highest-versioned deb for our arch from the latest stable Debian series
 * (currently bookworm = deb12, trixie = deb13).
 */
async function findLatestTorDebUrl(): Promise<string> {
  const arch = debArch();
  const poolUrl = "https://deb.debian.org/debian/pool/main/t/tor/";
  const listHtml = await new Promise<string>((resolve, reject) => {
    https.get(
      poolUrl,
      { headers: { "User-Agent": "tor-relay-installer/1.0" } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching pool index`));
          return;
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      },
    ).on("error", reject);
  });
  // Match all tor_<version>_<arch>.deb filenames
  const matches = listHtml.match(/tor_[0-9][^"']*?_(?:amd64|arm64|armhf)\.deb/g) || [];
  if (matches.length === 0) {
    throw new Error("could not find any tor .deb in pool index");
  }
  // Filter for our arch
  const ours = matches.filter((m) => m.endsWith(`_${arch}.deb`));
  if (ours.length === 0) {
    throw new Error(`no tor .deb for arch ${arch}`);
  }
  // Prefer the deb13 (trixie) build if available — it's the latest stable
  // Debian release with tor 0.4.9.x. Otherwise fall back to deb12.
  const deb13 = ours.filter((m) => m.includes("deb13"));
  const candidate = (deb13.length > 0 ? deb13 : ours).sort().reverse()[0];
  return poolUrl + candidate;
}

/**
 * Ensure a tor binary is available. If system-installed tor is present,
 * use it. Otherwise download the Debian .deb and extract it to LOCAL_TOR_PREFIX.
 *
 * This is idempotent — once extracted, subsequent boots find LOCAL_TOR_BIN
 * via the candidate list and skip the download.
 */
async function ensureTorBinary(): Promise<string> {
  // 1. already present?
  const existing = findExistingTorBinary();
  if (existing) return existing;

  // 2. need to download + extract
  console.log("[tor-installer] no tor binary found — downloading...");
  await fs.mkdir(TOR_DATA, { recursive: true });
  await fs.mkdir(LOCAL_TOR_PREFIX, { recursive: true });

  const debUrl = await findLatestTorDebUrl();
  const debFile = path.join(TOR_DATA, "tor.deb");
  console.log(`[tor-installer] downloading ${debUrl}`);
  await downloadToFile(debUrl, debFile);
  console.log(
    `[tor-installer] downloaded ${(await fs.stat(debFile)).size} bytes`,
  );

  // Extract using dpkg-deb -x if available, otherwise fall back to ar + tar.
  // dpkg-deb is more reliable; ar requires manual control.tar extraction.
  try {
    await exec(`dpkg-deb -x "${debFile}" "${LOCAL_TOR_PREFIX}"`);
    console.log(`[tor-installer] extracted via dpkg-deb to ${LOCAL_TOR_PREFIX}`);
  } catch (err) {
    // Fallback: use `ar` and `tar` (available on most systems without dpkg-deb)
    console.log("[tor-installer] dpkg-deb failed, falling back to ar + tar");
    const tmpAr = path.join(TOR_DATA, "extract-ar");
    await fs.mkdir(tmpAr, { recursive: true });
    await exec(`ar x "${debFile}" --output "${tmpAr}"`);
    // ar produces data.tar.xz (or .gz, or .bz2). Extract it.
    const dataTar = (await fs.readdir(tmpAr)).find((f) =>
      f.startsWith("data.tar"),
    );
    if (!dataTar) {
      throw new Error("could not find data.tar in .deb after ar extraction");
    }
    const dataTarPath = path.join(tmpAr, dataTar);
    if (dataTar.endsWith(".xz")) {
      await exec(`tar -xJf "${dataTarPath}" -C "${LOCAL_TOR_PREFIX}"`);
    } else if (dataTar.endsWith(".gz")) {
      await exec(`tar -xzf "${dataTarPath}" -C "${LOCAL_TOR_PREFIX}"`);
    } else if (dataTar.endsWith(".bz2")) {
      await exec(`tar -xjf "${dataTarPath}" -C "${LOCAL_TOR_PREFIX}"`);
    } else if (dataTar.endsWith(".zst")) {
      await exec(`tar --zstd -xf "${dataTarPath}" -C "${LOCAL_TOR_PREFIX}"`);
    } else {
      await exec(`tar -xf "${dataTarPath}" -C "${LOCAL_TOR_PREFIX}"`);
    }
    console.log(`[tor-installer] extracted via ar+tar to ${LOCAL_TOR_PREFIX}`);
  }

  // Verify
  if (!existsSync(LOCAL_TOR_BIN)) {
    throw new Error(
      `tor binary not found at ${LOCAL_TOR_BIN} after extraction`,
    );
  }
  await fs.chmod(LOCAL_TOR_BIN, 0o755);
  console.log(`[tor-installer] tor binary ready at ${LOCAL_TOR_BIN}`);
  return LOCAL_TOR_BIN;
}

const TOR_SOCKS = "127.0.0.1:9050";
const MAX_LOG_LINES = 60;

type TorState =
  | "stopped"
  | "starting"
  | "ready"
  | "binary-missing"
  | "binary-downloading"
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
  private torBin: string | null = null;

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
    if (!this.torBin) {
      this._state = "binary-missing";
      this.log("cannot spawn tor — no binary resolved");
      return;
    }
    void this.writeTorrc()
      .then((torrc) => {
        const child = spawn(this.torBin!, ["-f", torrc], {
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
    if (!this.torBin) {
      // Should not happen — start() resolves the binary first. But guard.
      this._state = "binary-missing";
      return;
    }
    this._state = "starting";
    this.startedAt = Date.now();
    this.log(`launching tor binary: ${this.torBin}`);
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
    h.unref?.();
  }

  /** Kick off the supervisor. Idempotent — calling multiple times is safe. */
  start() {
    if (this.started) return;
    this.started = true;
    this.startStatePollerOnce();

    // Resolve (or download) the tor binary, THEN spawn. Async.
    void (async () => {
      try {
        this._state = "binary-downloading";
        this.log("ensuring tor binary is available (download if missing)...");
        this.torBin = await ensureTorBinary();
        this.log(`tor binary resolved: ${this.torBin}`);
        this.spawnTorAndAwait();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._state = "binary-missing";
        this.log(`failed to obtain tor binary: ${msg}`);
      }
    })();
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
      binary: this.torBin || "(resolving...)",
      binary_candidates: torBinCandidates(),
      binary_download_dir: LOCAL_TOR_PREFIX,
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
