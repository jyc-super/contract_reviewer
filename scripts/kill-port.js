/**
 * Reliably kill processes on a given port (Windows).
 * Usage: node scripts/kill-port.js [port]
 *
 * - Parses netstat output properly (handles IPv4/IPv6)
 * - Kills all matching PIDs
 * - Waits up to 3 seconds for port to actually be released
 * - Exit 0 always (non-fatal)
 */

const { execSync } = require("child_process");
const net = require("net");

const port = parseInt(process.argv[2] || "3000", 10);

function getPidsOnPort(p) {
  try {
    const out = execSync(`netstat -ano`, { encoding: "utf8", timeout: 5000 });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      // Match lines like:
      //   TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345
      //   TCP    [::]:3000       [::]:0       LISTENING    12345
      if (!/LISTENING/i.test(line)) continue;
      const match = line.match(new RegExp(`[:\\]]${p}\\s`));
      if (!match) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
    }
    return pids;
  } catch {
    return new Set();
  }
}

function isPortFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(p, "0.0.0.0");
  });
}

async function main() {
  const pids = getPidsOnPort(port);
  if (pids.size === 0) {
    return;
  }

  console.log(`[kill-port] Killing ${pids.size} process(es) on port ${port}: ${[...pids].join(", ")}`);
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore", timeout: 5000 });
    } catch { /* ignore */ }
  }

  // Wait up to 3 seconds for port to be released
  for (let i = 0; i < 6; i++) {
    if (await isPortFree(port)) {
      console.log(`[kill-port] Port ${port} is free.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`[kill-port] Warning: port ${port} may still be in use.`);
}

main().catch(() => {});
