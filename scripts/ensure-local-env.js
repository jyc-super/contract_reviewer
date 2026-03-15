/**
 * Ensures .env.local has Supabase vars for local dev.
 * - WSL2 Docker Desktop: auto-detects WSL eth0 IP (changes on reboot)
 * - Always refreshes NEXT_PUBLIC_SUPABASE_URL with reachable host
 * - Only adds missing keys (never overwrites existing keys)
 * Exit code 0 even on failure so run.bat continues.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env.local");
const SUPABASE_PORT = 54321;

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function writeEnvFile(filePath, vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

/**
 * TCP connect test — returns true if host:port responds within timeoutMs.
 */
function tcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(timer); sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

/**
 * Detect the correct Supabase host for this machine.
 *
 * On Windows with Docker Desktop WSL2 backend, 127.0.0.1 port-forwarding
 * is broken — TCP SYN is accepted but traffic is not relayed.
 * The workaround is to use the WSL2 distro's eth0 IP directly.
 *
 * Detection order:
 *   1. WSL2 eth0 IP (wsl -d docker-desktop) → test TCP reachability
 *   2. 127.0.0.1 (standard Docker / native)  → test TCP reachability
 *   3. null (Docker not running or Supabase not started)
 */
async function detectSupabaseHost() {
  const candidates = [];

  // Try WSL2 Docker Desktop IP (Windows only)
  if (process.platform === "win32") {
    try {
      const r = spawnSync("wsl", ["-d", "docker-desktop", "ip", "addr", "show", "eth0"], {
        encoding: "utf8",
        timeout: 5000,
      });
      const stdout = r.stdout || "";
      const m = stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
      if (m) candidates.push(m[1]);
    } catch { /* WSL not available */ }
  }

  // Always try localhost as fallback
  candidates.push("127.0.0.1");

  for (const host of candidates) {
    const ok = await tcpReachable(host, SUPABASE_PORT, 2000);
    if (ok) {
      console.log(`[env] Supabase reachable at ${host}:${SUPABASE_PORT}`);
      return host;
    }
  }

  console.log("[env] Supabase not reachable on any candidate host");
  return null;
}

function getSupabaseKeys() {
  const tryJson = (str) => {
    if (!str) return null;
    try {
      const data = JSON.parse(str);
      const flat = typeof data === "object" && data !== null
        ? { ...data, ...(data.project || {}), ...(data.config || {}) }
        : {};
      return {
        serviceRoleKey: flat.SERVICE_ROLE_KEY ?? flat.service_role_key ?? null,
        anonKey: flat.ANON_KEY ?? flat.anon_key ?? null,
      };
    } catch { return null; }
  };

  const tryEnv = (str) => {
    if (!str) return null;
    const out = {};
    for (const line of str.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    return {
      serviceRoleKey: out.SERVICE_ROLE_KEY || null,
      anonKey: out.ANON_KEY || null,
    };
  };

  const run = (fmt) => {
    const r = spawnSync(`npx supabase status -o ${fmt}`, [], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, shell: true,
    });
    return (r.stdout || "").trim() || (r.stderr || "").trim();
  };

  let result = tryJson(run("json"));
  if (result?.serviceRoleKey) return result;
  result = tryEnv(run("env"));
  if (result?.serviceRoleKey) return result;
  return null;
}

async function main() {
  const current = parseEnvFile(ENV_PATH);
  const toUpdate = {};

  // 1. Always refresh Supabase URL (WSL2 IP can change on reboot)
  const host = await detectSupabaseHost();
  if (host) {
    const newUrl = `http://${host}:${SUPABASE_PORT}`;
    const oldUrl = current.NEXT_PUBLIC_SUPABASE_URL;
    if (oldUrl !== newUrl) {
      toUpdate.NEXT_PUBLIC_SUPABASE_URL = newUrl;
      if (oldUrl) {
        console.log(`[env] Supabase URL updated: ${oldUrl} → ${newUrl}`);
      } else {
        console.log(`[env] Supabase URL set: ${newUrl}`);
      }
    } else {
      console.log("[env] Supabase URL unchanged");
    }
  }

  // 2. Fill missing keys (only if not already set)
  const hasKey = !!current.SUPABASE_SERVICE_ROLE_KEY;
  if (!hasKey) {
    const keys = getSupabaseKeys();
    if (keys?.serviceRoleKey) {
      toUpdate.SUPABASE_SERVICE_ROLE_KEY = keys.serviceRoleKey;
      console.log("[env] SUPABASE_SERVICE_ROLE_KEY set from supabase status");
    }
    if (keys?.anonKey && !current.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      toUpdate.NEXT_PUBLIC_SUPABASE_ANON_KEY = keys.anonKey;
      console.log("[env] NEXT_PUBLIC_SUPABASE_ANON_KEY set from supabase status");
    }
  }

  if (Object.keys(toUpdate).length === 0) {
    console.log("[env] No changes needed");
    process.exit(0);
    return;
  }

  const merged = { ...current, ...toUpdate };
  writeEnvFile(ENV_PATH, merged);
  console.log("[env] .env.local updated");
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.log("[env] Error:", e.message);
  process.exit(0);
}
