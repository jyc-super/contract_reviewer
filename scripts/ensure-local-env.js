/**
 * Ensures .env.local has Supabase vars for local dev.
 * only missing keys so existing .env.local is never overwritten.
 * Exit code 0 even on failure so run.bat continues.
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env.local");


const TARGET_VARS = {
  NEXT_PUBLIC_SUPABASE_URL: null,
  SUPABASE_SERVICE_ROLE_KEY: null,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: null,
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
  return null;
}

function main() {
const current = parseEnvFile(ENV_PATH);
  const toAdd = {};
  const values = getSupabaseValues();
if (values?.url) {
    if (!current.NEXT_PUBLIC_SUPABASE_URL) toAdd.NEXT_PUBLIC_SUPABASE_URL = values.url;
    if (values.serviceRoleKey && !current.SUPABASE_SERVICE_ROLE_KEY)
      toAdd.SUPABASE_SERVICE_ROLE_KEY = values.serviceRoleKey;
    if (values.anonKey && !current.NEXT_PUBLIC_SUPABASE_ANON_KEY)
      toAdd.NEXT_PUBLIC_SUPABASE_ANON_KEY = values.anonKey;
  }

if (Object.keys(toAdd).length === 0) {
    process.exit(0);
    return;
  }

  const merged = { ...current, ...toAdd };
writeEnvFile(ENV_PATH, merged);
  process.exit(0);
}

try {
  main();
} catch (e) {
  process.exit(0);
}
