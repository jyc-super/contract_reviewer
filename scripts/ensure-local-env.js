/**
 * Ensures .env.local has Supabase and Docling vars for local dev.
 * Reads from `npx supabase status -o json` (or -o env fallback) and appends
 * only missing keys so existing .env.local is never overwritten.
 * Exit code 0 even on failure so run.bat continues.
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env.local");

// #region agent log
const LOG_DIR = ROOT;
const LOG_PATH = path.join(LOG_DIR, "debug-b06c12.log");
const SCRIPT_LOG = path.join(__dirname, "ensure-local-env-run.log");
function debugLog(message, data, hypothesisId) {
  const payload = { sessionId: "b06c12", location: "ensure-local-env.js", message, data: data || {}, timestamp: Date.now(), hypothesisId: hypothesisId || null };
  const line = JSON.stringify(payload) + "\n";
  try { fs.appendFileSync(LOG_PATH, line, "utf8"); } catch (_) {}
  try { fs.appendFileSync(SCRIPT_LOG, line, "utf8"); } catch (_) {}
  fetch("http://127.0.0.1:7399/ingest/03b57e5a-e83f-4605-bb0f-fb2aabef1b25", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b06c12" }, body: JSON.stringify(payload) }).catch(() => {});
}
// #endregion

const TARGET_VARS = {
  NEXT_PUBLIC_SUPABASE_URL: null,
  SUPABASE_SERVICE_ROLE_KEY: null,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: null,
  DOCLING_SERVICE_URL: "http://localhost:5001",
};

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

function getSupabaseValues() {
  const tryJson = (str) => {
    if (!str) return null;
    try {
      const data = JSON.parse(str);
      const flat = typeof data === "object" && data !== null ? { ...data, ...(data.project || {}), ...(data.config || {}) } : {};
      return {
        url: flat.API_URL ?? flat.api_url ?? flat.ApiUrl,
        serviceRoleKey: flat.SERVICE_ROLE_KEY ?? flat.service_role_key,
        anonKey: flat.ANON_KEY ?? flat.anon_key,
      };
    } catch {
      return null;
    }
  };

  const tryEnv = (str) => {
    if (!str) return null;
    const out = {};
    for (const line of str.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    const url = out.API_URL ?? out.SUPABASE_URL;
    if (!url) return null;
    return {
      url,
      serviceRoleKey: out.SERVICE_ROLE_KEY || null,
      anonKey: out.ANON_KEY || null,
    };
  };

  const runJson = () => {
    const r = spawnSync("npx supabase status -o json", [], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: true,
    });
    return { stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status, error: r.error ? String(r.error) : null };
  };

  const runEnv = () => {
    const r = spawnSync("npx supabase status -o env", [], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: true,
    });
    return { stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status, error: r.error ? String(r.error) : null };
  };

  const jsonRun = runJson();
  const stdout = jsonRun.stdout || jsonRun.stderr;
  let result = tryJson(stdout);
  if (result?.url) return result;
  const envRun = runEnv();
  const envOut = envRun.stdout || envRun.stderr;
  result = tryEnv(envOut);
  if (result?.url) return result;
  debugLog("getSupabaseValues failed", {
    jsonStatus: jsonRun.status,
    jsonError: jsonRun.error,
    jsonStderr: (jsonRun.stderr || "").slice(0, 300),
    envStatus: envRun.status,
    envError: envRun.error,
    envStderr: (envRun.stderr || "").slice(0, 300),
  }, "H1");
  return null;
}

function main() {
  // #region agent log
  debugLog("script started", {}, "H3");
  // #endregion
  const current = parseEnvFile(ENV_PATH);
  const toAdd = {};
  const values = getSupabaseValues();
  // #region agent log
  debugLog("getSupabaseValues result", { hasUrl: !!values?.url, hasServiceKey: !!values?.serviceRoleKey, hasAnonKey: !!values?.anonKey }, "H1");
  debugLog("current env keys", { keys: Object.keys(current) }, "H2");
  // #endregion
  if (values?.url) {
    if (!current.NEXT_PUBLIC_SUPABASE_URL) toAdd.NEXT_PUBLIC_SUPABASE_URL = values.url;
    if (values.serviceRoleKey && !current.SUPABASE_SERVICE_ROLE_KEY)
      toAdd.SUPABASE_SERVICE_ROLE_KEY = values.serviceRoleKey;
    if (values.anonKey && !current.NEXT_PUBLIC_SUPABASE_ANON_KEY)
      toAdd.NEXT_PUBLIC_SUPABASE_ANON_KEY = values.anonKey;
  }

  if (!current.DOCLING_SERVICE_URL) toAdd.DOCLING_SERVICE_URL = TARGET_VARS.DOCLING_SERVICE_URL;

  // #region agent log
  debugLog("toAdd keys", { keys: Object.keys(toAdd), toAddCount: Object.keys(toAdd).length }, "H2");
  // #endregion
  if (Object.keys(toAdd).length === 0) {
    process.exit(0);
    return;
  }

  const merged = { ...current, ...toAdd };
  // #region agent log
  debugLog("writing env file", { mergedKeys: Object.keys(merged) }, "H2");
  // #endregion
  writeEnvFile(ENV_PATH, merged);
  process.exit(0);
}

try {
  try { fs.appendFileSync(path.join(__dirname, "ensure-local-env-run.log"), "started " + Date.now() + " cwd=" + process.cwd() + " ROOT=" + path.resolve(__dirname, "..") + "\n", "utf8"); } catch (_) {}
  main();
} catch (e) {
  // #region agent log
  debugLog("script error", { error: String(e && e.message) }, "H1");
  // #endregion
  process.exit(0);
}
