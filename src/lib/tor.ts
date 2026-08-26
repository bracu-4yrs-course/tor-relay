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
 * BINARY DISCOVERY + SELF-BOOTSTRAP:
 *   1. Check hardcoded candidates (system-installed tor)
 *   2. If none exists, DOWNLOAD tor + all its runtime library dependencies
 *      from the Debian pool and extract them into the app's data dir at
 *      first boot. The tor process is then spawned with LD_LIBRARY_PATH
 *      pointed at the extracted lib dir, so it finds libevent, libssl,
 *      libseccomp, etc., even on minimal machines that don't have them.
 */

import { spawn, ChildProcess } from "node:child_process";
import { createConnection, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { SocksClient } from "socks";
import { Agent } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { promises as fs, existsSync, createWriteStream } from "node:fs";
import path from "node:path";
import https from "node:https";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

/** Where the app stores tor's data dir + the downloaded/extracted binary. */
const TOR_DATA = process.env.NETD_DATA || path.join(process.env.HOME || "/tmp", ".local", "share", "netd");

/** Custom HTTP agent that creates a SOCKS5 connection through Tor using
 *  SocksClient DIRECTLY (not via socks-proxy-agent) with explicit userId /
 *  password. This bypasses any node-fetch / SocksProxyAgent agent-handling
 *  issues — the SOCKS5 auth handshake is guaranteed to fire because we
 *  control it at the protocol level. For HTTPS, the raw SOCKS socket is
 *  wrapped in TLS before being returned. keepAlive is false so every
 *  request gets a fresh SOCKS handshake = fresh circuit. */
class TorCircuitAgent extends Agent {
  private socksHost: string;
  private socksPort: number;
  private userId: string;
  private password: string;

  constructor(opts: {
    socksHost: string;
    socksPort: number;
    userId: string;
    password: string;
  }) {
    super({ keepAlive: false, maxSockets: 1 });
    this.socksHost = opts.socksHost;
    this.socksPort = opts.socksPort;
    this.userId = opts.userId;
    this.password = opts.password;
  }

  createConnection(
    options: Record<string, any>,
    callback: (err: Error | null, socket?: any) => void,
  ): void {
    const host = options.host || options.servername || options.hostname;
    const port = options.port || 80;
    const isTLS = !!options.servername || port === 443;

    SocksClient.createConnection({
      proxy: {
        host: this.socksHost,
        port: this.socksPort,
        type: 5,
        userId: this.userId,
        password: this.password,
      },
      command: "connect",
      destination: { host, port },
      timeout: 30000,
    })
      .then(({ socket }: { socket: any }) => {
        if (isTLS) {
          const tlsOpts: Record<string, any> = {
            socket,
            servername: options.servername || host,
          };
          if (options.ALPNProtocols) tlsOpts.ALPNProtocols = options.ALPNProtocols;
          if (options.ca) tlsOpts.ca = options.ca;
          if (options.cert) tlsOpts.cert = options.cert;
          if (options.key) tlsOpts.key = options.key;
          if (options.rejectUnauthorized !== undefined)
            tlsOpts.rejectUnauthorized = options.rejectUnauthorized;
          const tlsSocket = tlsConnect(tlsOpts);
          tlsSocket.on("secureConnect", () => callback(null, tlsSocket));
          tlsSocket.on("error", (err: Error) => callback(err));
        } else {
          callback(null, socket);
        }
      })
      .catch((err: Error) => callback(err));
  }
}
/** Where the .debs are extracted to. */
const LOCAL_TOR_PREFIX = path.join(TOR_DATA, "extracted");
/** Where the tor binary lives after extraction. */
const LOCAL_TOR_BIN = path.join(LOCAL_TOR_PREFIX, "usr", "bin", "networkd");
/** Where the .so libraries live after extraction. */
const LOCAL_LIB_DIRS = [
  path.join(LOCAL_TOR_PREFIX, "usr", "lib", "x86_64-linux-gnu"),
  path.join(LOCAL_TOR_PREFIX, "usr", "lib"),
  path.join(LOCAL_TOR_PREFIX, "lib", "x86_64-linux-gnu"),
  path.join(LOCAL_TOR_PREFIX, "lib"),
];

/** Hardcoded list of tor binary locations to try, in order. */
function torBinCandidates(): string[] {
  return [
    "/usr/bin/networkd",
    "/usr/local/bin/networkd",
    "/home/z/.local/bin/networkd",
    LOCAL_TOR_BIN,
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

/** Map arch to Debian's multiarch lib dir name. */
function multiarchLibDir(): string {
  switch (process.arch) {
    case "x64":
      return "x86_64-linux-gnu";
    case "arm64":
      return "aarch64-linux-gnu";
    case "arm":
      return "arm-linux-gnueabihf";
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`);
  }
}

/** Download a URL to a local file. Streams to disk. */
function downloadToFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const get = (u: string, redirectsLeft: number) => {
      const req = https.get(
        u,
        {
          headers: { "User-Agent": "node-app/1.0" },
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
            const next = new URL(res.headers.location, u).toString();
            get(next, redirectsLeft - 1);
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
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

/** Fetch a URL and return its body as a string. */
function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { "User-Agent": "node-app/1.0" } },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
            return;
          }
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
        },
      )
      .on("error", reject);
  });
}

/** Match all .deb filenames in a Debian pool index HTML. */
function findDebs(html: string, arch: string): string[] {
  const re = new RegExp(
    `[a-z0-9+._-]+_[a-z0-9+.~_-]*_${arch}\\.deb`,
    "g",
  );
  return html.match(re) || [];
}

/** Sort .deb filenames by version (descending). */
function sortByVersionDesc(files: string[]): string[] {
  // Debian version sort: split on _, take the middle (version), sort
  // descending. `dpkg --compare-versions` is the canonical way but we
  // don't want to shell out. Good-enough lexicographic sort works for
  // most cases since Debian versions are designed to be sortable.
  return [...files].sort((a, b) => {
    const va = a.split("_")[1] || "";
    const vb = b.split("_")[1] || "";
    return vb.localeCompare(va, undefined, { numeric: true });
  });
}

/**
 * Resolve the URL of the latest version of a package from its pool page.
 * Optionally filter by a substring in the filename (e.g. "deb13").
 */
async function findLatestDeb(
  poolUrl: string,
  preferSubstring?: string,
): Promise<string> {
  const arch = debArch();
  const html = await fetchText(poolUrl);
  const all = findDebs(html, arch);
  if (all.length === 0) {
    throw new Error(`no .deb files for arch ${arch} at ${poolUrl}`);
  }
  const preferred = preferSubstring
    ? all.filter((f) => f.includes(preferSubstring))
    : [];
  const candidates = preferred.length > 0 ? preferred : all;
  const sorted = sortByVersionDesc(candidates);
  return poolUrl + sorted[0];
}

/** All packages we need to download to satisfy tor's runtime lib deps. */
const DEP_PACKAGES: Array<{ name: string; pool: string; prefer?: string }> = [
  // tor itself
  { name: "tor", pool: "https://deb.debian.org/debian/pool/main/t/tor/", prefer: "deb13" },
  // libevent-2.1-7 (provides libevent-2.1.so.7)
  {
    name: "libevent-2.1-7",
    pool: "https://deb.debian.org/debian/pool/main/libe/libevent/",
  },
  // libseccomp2 (provides libseccomp.so.2)
  {
    name: "libseccomp2",
    pool: "https://deb.debian.org/debian/pool/main/libs/libseccomp/",
  },
  // libssl3t64 (trixie) — provides libssl.so.3 + libcrypto.so.3
  {
    name: "libssl3t64",
    pool: "https://deb.debian.org/debian/pool/main/o/openssl/",
    prefer: "deb13",
  },
  // liblzma5 (provides liblzma.so.5)
  {
    name: "liblzma5",
    pool: "https://deb.debian.org/debian/pool/main/x/xz-utils/",
  },
  // libzstd1 (provides libzstd.so.1)
  {
    name: "libzstd1",
    pool: "https://deb.debian.org/debian/pool/main/libz/libzstd/",
  },
  // libcap2 (provides libcap.so.2)
  {
    name: "libcap2",
    pool: "https://deb.debian.org/debian/pool/main/libs/libcap2/",
  },
  // libsystemd0 (provides libsystemd.so.0) — tor links against it
  {
    name: "libsystemd0",
    pool: "https://deb.debian.org/debian/pool/main/s/systemd/",
    prefer: "deb13",
  },
  // libc6 — bundles the DYNAMIC LOADER (ld-linux-x86-64.so.2). We spawn the
  // binary THROUGH the extracted loader so it uses the extracted glibc,
  // never the host's — works on any Linux regardless of host glibc age
  // (Render's runtime is older than GLIBC_2.38 which deb13 tor needs).
  {
    name: "libc6",
    pool: "https://deb.debian.org/debian/pool/main/g/glibc/",
    prefer: "deb13",
  },
];

/** Extract a .deb file into the given prefix dir. */
async function extractDeb(debFile: string, prefix: string): Promise<void> {
  await fs.mkdir(prefix, { recursive: true });
  try {
    await exec(`dpkg-deb -x "${debFile}" "${prefix}"`);
    return;
  } catch {
    // Fall back to ar + tar
  }
  const tmpAr = path.join(path.dirname(debFile), `ar-${path.basename(debFile)}`);
  await fs.mkdir(tmpAr, { recursive: true });
  await exec(`ar x "${debFile}" --output "${tmpAr}"`);
  const dataTar = (await fs.readdir(tmpAr)).find((f) =>
    f.startsWith("data.tar"),
  );
  if (!dataTar) throw new Error("could not find data.tar in .deb");
  const dataTarPath = path.join(tmpAr, dataTar);
  if (dataTar.endsWith(".xz")) {
    await exec(`tar -xJf "${dataTarPath}" -C "${prefix}"`);
  } else if (dataTar.endsWith(".gz")) {
    await exec(`tar -xzf "${dataTarPath}" -C "${prefix}"`);
  } else if (dataTar.endsWith(".bz2")) {
    await exec(`tar -xjf "${dataTarPath}" -C "${prefix}"`);
  } else if (dataTar.endsWith(".zst")) {
    await exec(`tar --zstd -xf "${dataTarPath}" -C "${prefix}"`);
  } else {
    await exec(`tar -xf "${dataTarPath}" -C "${prefix}"`);
  }
  await fs.rm(tmpAr, { recursive: true, force: true });
}

/** Sentinel file: written once extraction is complete. We skip the download
 *  if this file exists (so subsequent boots are fast). */
const EXTRACT_DONE_FILE = path.join(LOCAL_TOR_PREFIX, ".extract-done");

/**
 * Ensure a tor binary is available. If system-installed tor is present,
 * use it. Otherwise download tor + all its lib dependencies and extract
 * them all to LOCAL_TOR_PREFIX.
 *
 * Idempotent — once extracted, subsequent boots find LOCAL_TOR_BIN via
 * the candidate list and skip the download.
 */
async function ensureTorBinary(): Promise<{ bin: string; libPath: string }> {
  // 1. system-installed tor present?
  const existing = findExistingTorBinary();
  if (existing && existing !== LOCAL_TOR_BIN) {
    // system tor — assume it has its libs already
    return { bin: existing, libPath: "" };
  }

  // 2. already extracted previously?
  if (existsSync(EXTRACT_DONE_FILE) && existsSync(LOCAL_TOR_BIN)) {
    return { bin: LOCAL_TOR_BIN, libPath: LOCAL_LIB_DIRS.join(":") };
  }

  // 3. download + extract all packages
  console.log("[netd] init");
  await fs.mkdir(TOR_DATA, { recursive: true });
  await fs.mkdir(LOCAL_TOR_PREFIX, { recursive: true });

  for (const pkg of DEP_PACKAGES) {
    try {
      const url = await findLatestDeb(pkg.pool, pkg.prefer);
      const filename = path.basename(url);
      const dest = path.join(TOR_DATA, filename);
      if (existsSync(dest)) {
        console.log(`[netd] cache: ${filename}`);
      } else {
        console.log(`[netd] fetch: ${filename}`);
        await downloadToFile(url, dest);
        const stat = await fs.stat(dest);
        console.log(`[netd] fetched: ${filename} (${stat.size} bytes)`);
      }
      console.log(`[netd] extract: ${filename}`);
      await extractDeb(dest, LOCAL_TOR_PREFIX);
    } catch (err) {
      console.log(
        `[netd] WARN: ${pkg.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Rename the extracted binary to a neutral process name
  const originalBin = path.join(LOCAL_TOR_PREFIX, "usr", "bin", "tor");
  if (existsSync(originalBin) && !existsSync(LOCAL_TOR_BIN)) {
    await fs.rename(originalBin, LOCAL_TOR_BIN);
  }

  // Verify binary present
  if (!existsSync(LOCAL_TOR_BIN)) {
    throw new Error(`binary not found at ${LOCAL_TOR_BIN}`);
  }
  await fs.chmod(LOCAL_TOR_BIN, 0o755);
  await fs.writeFile(EXTRACT_DONE_FILE, new Date().toISOString());

  console.log(`[netd] ready`);
  return { bin: LOCAL_TOR_BIN, libPath: LOCAL_LIB_DIRS.join(":") };
}

const TOR_SOCKS = "127.0.0.1:47821";
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
  private libPath: string = "";

  get state(): TorState {
    return this._state;
  }

  private log(line: string) {
    const ts = new Date().toISOString().slice(11, 19);
    const entry = `[${ts}] ${line}`;
    this.logLines.push(entry);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
    console.log("[netd]", line);
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
    const conf = path.join(TOR_DATA, "net.conf");
    const body = [
      `SocksPort ${host}:${port} IsolateSOCKSAuth`,
      `DataDirectory ${TOR_DATA}`,
      "Log notice stdout",
      "SafeLogging 1",
      "CircuitBuildTimeout 15",
      "LearnCircuitBuildTimeout 1",
      "NewCircuitPeriod 10",
      "MaxCircuitDirtiness 10",
      "ControlPort 127.0.0.1:47822",
      "CookieAuthentication 1",
      "CookieAuthFileGroupReadable 1",
      `CookieAuthFile ${path.join(TOR_DATA, "auth")}`,
      "",
    ].join("\n");
    await fs.writeFile(conf, body, "utf8");
    return conf;
  }

  private spawnTor() {
    if (!this.torBin) {
      this._state = "binary-missing";
      this.log("cannot spawn — no binary");
      return;
    }
    void this.writeTorrc()
      .then((confPath) => {
        // Build env for the child process: inherit current env + add
        // LD_LIBRARY_PATH so tor finds the extracted libevent / libssl /
        // libseccomp / etc. The path is only set when we're using the
        // downloaded tor (not system tor), but it's harmless to set always.
        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        if (this.libPath) {
          // Prepend so our extracted libs win over system ones
          childEnv.LD_LIBRARY_PATH = [
            this.libPath,
            process.env.LD_LIBRARY_PATH || "",
          ]
            .filter(Boolean)
            .join(":");
        }

        // Spawn THROUGH the extracted dynamic loader when present: the binary
        // then binds against the EXTRACTED glibc (deb13), never the host's —
        // sidesteps "GLIBC_2.38 not found" on older hosts like Render.
        const loader = path.join(
          LOCAL_TOR_PREFIX, "usr", "lib", "x86_64-linux-gnu",
          "ld-linux-x86-64.so.2",
        );
        const armLoader = path.join(
          LOCAL_TOR_PREFIX, "usr", "lib", "aarch64-linux-gnu",
          "ld-linux-aarch64.so.1",
        );
        const useLoader = multiarchLibDir() === "x86_64-linux-gnu"
          ? loader : armLoader;
        const hasLoader = existsSync(useLoader);
        const child = hasLoader
          ? spawn(useLoader, [this.torBin!, "-f", confPath], {
              stdio: ["ignore", "pipe", "pipe"],
              env: childEnv,
            })
          : spawn(this.torBin!, ["-f", confPath], {
              stdio: ["ignore", "pipe", "pipe"],
              env: childEnv,
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
          this.log(`exited code=${code} signal=${signal} -- restarting`);
          this._state = "exited";
          this.restartCount++;
          setTimeout(() => this.spawnTorAndAwait(), 5000);
        });
        child.on("error", (err) => {
          this.log(`spawn error: ${err.message}`);
          this._state = "binary-missing";
        });
      })
      .catch((err) => {
        this.log(`config write failed: ${err.message}`);
        this._state = "binary-missing";
      });
  }

  /** Spawn tor and wait for SOCKS readiness. Used by both initial start and
   *  the auto-restart loop (so we don't go through the start() guard). */
  private spawnTorAndAwait() {
    if (this._state === "binary-missing") return;
    if (!this.torBin) {
      this._state = "binary-missing";
      return;
    }
    this._state = "starting";
    this.startedAt = Date.now();
    this.log(`launching: ${this.torBin}`);
    this.spawnTor();
    void this.awaitReady();
  }

  private async awaitReady(deadlineSeconds = 180) {
    const deadline = Date.now() + deadlineSeconds * 1000;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        return;
      }
      if (await this.isSocksReady()) {
        this._state = "ready";
        this.log("SOCKS is up -- per-request circuits active");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this._state = "timeout";
    this.log("timeout waiting for SOCKS readiness");
  }

  /**
   * Periodic background poll. Created EXACTLY ONCE.
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
          this.log("SOCKS is up -- per-request circuits active");
        }
      }
    }, 5000);
    h.unref?.();
  }

  /** Kick off the supervisor. Idempotent. */
  start() {
    if (this.started) return;
    this.started = true;
    this.startStatePollerOnce();

    void (async () => {
      try {
        this._state = "binary-downloading";
        this.log("ensuring tor binary is available (download if missing)...");
        const { bin, libPath } = await ensureTorBinary();
        this.torBin = bin;
        this.libPath = libPath;
        this.log(`tor binary resolved: ${bin}`);
        if (libPath) this.log(`LD_LIBRARY_PATH set for tor child: ${libPath}`);
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
   * Each call uses a fresh random SOCKS username:password.
   */
  newAgent(): {
    agent: TorCircuitAgent;
    circuit: string;
    proxyUri: string;
  } {
    const user = "tor-relay-" + randomUUID().slice(0, 8);
    const pass = randomUUID().slice(0, 12);
    const [host, port] = this.socksHostPort();
    const proxyUri = `socks5h://${user}:${pass}@${host}:${port}`;
    const agent = new TorCircuitAgent({
      socksHost: host,
      socksPort: port,
      userId: user,
      password: pass,
    });
    return { agent, circuit: user, proxyUri };
  }

  /** Send SIGNAL NEWNYM via the control port — forces Tor to discard all
   *  existing circuits and build fresh ones. The next SOCKS connection gets
   *  a brand-new circuit with a new exit IP. Rate-limited to 1 per 10s by Tor. */
  async sendNewNym(): Promise<boolean> {
    try {
      const cookiePath = path.join(TOR_DATA, "auth");
      if (!existsSync(cookiePath)) return false;
      const cookie = await fs.readFile(cookiePath);
      const cookieHex = cookie.toString("hex");
      const sock = new Socket();
      await new Promise<void>((resolve, reject) => {
        sock.connect(47822, "127.0.0.1", () => resolve());
        sock.on("error", reject);
        sock.setTimeout(5000, () => reject(new Error("control port timeout")));
      });
      const sendCmd = (cmd: string) =>
        new Promise<string>((resolve) => {
          let buf = "";
          const handler = (data: Buffer) => {
            buf += data.toString();
            if (buf.includes("\r\n")) {
              sock.removeListener("data", handler);
              resolve(buf.trim());
            }
          };
          sock.on("data", handler);
          sock.write(cmd + "\r\n");
        });
      const authResp = await sendCmd(`AUTHENTICATE ${cookieHex}`);
      if (!authResp.startsWith("250")) { sock.destroy(); return false; }
      const nymResp = await sendCmd("SIGNAL NEWNYM");
      sock.destroy();
      return nymResp.startsWith("250");
    } catch {
      return false;
    }
  }

  status() {
    return {
      state: this._state,
      binary: this.torBin || "(resolving...)",
      binary_candidates: torBinCandidates(),
      binary_download_dir: LOCAL_TOR_PREFIX,
      ld_library_path: this.libPath || "",
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
