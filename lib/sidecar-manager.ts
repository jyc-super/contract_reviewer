/**
 * lib/sidecar-manager.ts
 *
 * Manages the lifecycle of the Docling Python sidecar process within the
 * Next.js Node.js runtime.  Designed to be called once from instrumentation.ts
 * during server startup, with HMR-safe singleton tracking via a process-level
 * global symbol so the sidecar is never double-spawned across module reloads.
 *
 * Windows-only concern: we resolve the venv python executable relative to the
 * project root so the correct interpreter and installed packages are used.
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ── Process-level singleton key ────────────────────────────────────────────
// Using a Symbol on globalThis survives Next.js HMR module cache busting.
const SINGLETON_KEY = Symbol.for("docling.sidecarManager");

interface SidecarGlobal {
  process: ChildProcess | null;
  starting: boolean;
  ready: boolean;
  startPromise: Promise<void> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __docling_sidecar__: SidecarGlobal | undefined;
}

function getSingleton(): SidecarGlobal {
  if (!globalThis.__docling_sidecar__) {
    globalThis.__docling_sidecar__ = {
      process: null,
      starting: false,
      ready: false,
      startPromise: null,
    };
  }
  return globalThis.__docling_sidecar__;
}

// ── Config ─────────────────────────────────────────────────────────────────

// process.cwd() is used instead of __dirname because in Next.js 14 App Router,
// instrumentation.ts runs from .next/server/ context where __dirname resolves
// to the build output directory, not the project root.
const PROJECT_ROOT = process.cwd();

/** Port the sidecar listens on.  Must match DOCLING_SIDECAR_URL in .env.local. */
function getSidecarPort(): number {
  const raw = process.env.DOCLING_SIDECAR_PORT ?? "8766";
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 8766;
}

function getSidecarUrl(): string {
  return process.env.DOCLING_SIDECAR_URL ?? `http://127.0.0.1:${getSidecarPort()}`;
}

const VENV_DIR = path.join(PROJECT_ROOT, ".venv");
const VENV_PYTHON =
  process.platform === "win32"
    ? path.join(VENV_DIR, "Scripts", "python.exe")
    : path.join(VENV_DIR, "bin", "python");

/**
 * Returns true if the given Python executable actually runs.
 *
 * - Absolute paths (venv): shell: false — direct CreateProcess, no injection risk.
 * - Command names (py, python, python3): shell: true — lets cmd.exe apply PATHEXT
 *   so "py" resolves to "py.exe".  Without this, Node.js spawnSync bypasses
 *   PATHEXT on Windows and always gets ENOENT for bare command names.
 */
function isPythonUsable(python: string): boolean {
  const useShell = !path.isAbsolute(python);
  const result = spawnSync(python, ["-c", "import sys; print(sys.version)"], {
    encoding: "utf-8",
    timeout: 8_000,
    windowsHide: true,
    shell: useShell,
  });

  if (result.error) {
    // ENOENT = executable not found; other errors = permission, timeout, etc.
    const code = (result.error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code !== "ENOENT") {
      console.warn(`[SidecarManager] isPythonUsable(${python}): ${code} — ${result.error.message}`);
    }
    return false;
  }

  // Also require non-empty stdout — Microsoft Store Python stub exits 0 but
  // produces no output because it redirects to the Store instead of running.
  return result.status === 0 && !!result.stdout?.trim();
}

/**
 * Returns the Python version encoded as major*100+minor (e.g. 310 = 3.10),
 * or null if the version cannot be determined.
 */
function getPythonVersion(python: string): number | null {
  const useShell = !path.isAbsolute(python);
  const result = spawnSync(
    python,
    ["-c", "import sys; print(sys.version_info.major * 100 + sys.version_info.minor)"],
    { encoding: "utf-8", timeout: 8_000, windowsHide: true, shell: useShell }
  );
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  const v = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(v) ? v : null;
}

/**
 * Returns candidate absolute Python paths on Windows for installs that did
 * not add themselves to PATH (e.g. "Add to PATH" was unchecked during install).
 */
function windowsFallbackPythonPaths(): string[] {
  if (process.platform !== "win32") return [];

  const localAppData = process.env.LOCALAPPDATA ?? "";
  const userProfile = process.env.USERPROFILE ?? "";
  const candidates: string[] = [];

  // Python.org standard per-user install (Python312, Python311, Python310, Python39)
  for (const ver of ["312", "311", "310", "39"]) {
    if (localAppData) {
      candidates.push(
        path.join(localAppData, "Programs", "Python", `Python${ver}`, "python.exe")
      );
    }
    candidates.push(`C:\\Python${ver}\\python.exe`);
  }

  // pyenv-win
  if (userProfile) {
    candidates.push(path.join(userProfile, ".pyenv", "pyenv-win", "shims", "python.exe"));
  }

  // Conda/Miniconda
  for (const base of [
    userProfile ? path.join(userProfile, "miniconda3") : "",
    userProfile ? path.join(userProfile, "anaconda3") : "",
    "C:\\ProgramData\\miniconda3",
  ]) {
    if (base) candidates.push(path.join(base, "python.exe"));
  }

  return candidates.filter((p) => fs.existsSync(p));
}

/** Finds a working system Python (not the venv). Returns null if none found. */
function findSystemPython(): string | null {
  // 1st pass: PATH-based (shell:true handles PATHEXT on Windows)
  for (const candidate of ["py", "python3", "python"]) {
    if (isPythonUsable(candidate)) {
      console.log(`[SidecarManager] System Python found via PATH: ${candidate}`);
      return candidate;
    }
  }

  // 2nd pass: absolute paths for Python installs not added to PATH
  for (const candidate of windowsFallbackPythonPaths()) {
    if (isPythonUsable(candidate)) {
      console.log(`[SidecarManager] System Python found via absolute path: ${candidate}`);
      return candidate;
    }
  }

  return null;
}

/**
 * Recreates the .venv directory using the given system Python.
 * Returns true on success.
 */
function recreateVenv(systemPython: string): boolean {
  console.log(`[SidecarManager] Recreating .venv with ${systemPython}...`);

  // Remove broken venv
  try {
    fs.rmSync(VENV_DIR, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[SidecarManager] Could not remove old .venv: ${err}`);
  }

  const result = spawnSync(systemPython, ["-m", "venv", VENV_DIR], {
    encoding: "utf-8",
    timeout: 60_000,
    windowsHide: true,
    cwd: PROJECT_ROOT,
  });

  if (result.stdout?.trim()) console.log(`[venv] ${result.stdout.trim()}`);
  if (result.stderr?.trim()) console.log(`[venv] ${result.stderr.trim()}`);

  if (result.status !== 0) {
    console.error(`[SidecarManager] venv creation failed (exit ${result.status ?? "?"}).`);
    return false;
  }

  console.log("[SidecarManager] .venv created successfully.");
  return true;
}

/**
 * Returns a working venv Python path, recreating the venv if it is broken or
 * missing. Returns null if recovery is not possible (no system Python found).
 */
function resolveOrRepairPython(): string | null {
  // Happy path: venv exists and works
  if (fs.existsSync(VENV_PYTHON) && isPythonUsable(VENV_PYTHON)) {
    return VENV_PYTHON;
  }

  const reason = fs.existsSync(VENV_PYTHON)
    ? "venv Python is broken (original interpreter uninstalled?)"
    : ".venv not found";

  console.warn(`[SidecarManager] ${reason}. Attempting automatic recovery...`);

  const systemPython = findSystemPython();
  if (!systemPython) {
    console.error(
      "[SidecarManager] No system Python found " +
        "(tried PATH: py, python3, python — and common Windows install locations). " +
        "Install Python 3.10+ from python.org and re-run."
    );
    return null;
  }

  // Docling requires Python 3.10+
  const ver = getPythonVersion(systemPython);
  if (ver === null || ver < 310) {
    console.error(
      `[SidecarManager] System Python at "${systemPython}" is too old ` +
        `(detected version code: ${ver ?? "unknown"}, need 3.10+). ` +
        "Install Python 3.10+ and re-run."
    );
    return null;
  }
  console.log(`[SidecarManager] System Python version OK (${Math.floor(ver / 100)}.${ver % 100}).`);

  if (!recreateVenv(systemPython)) return null;

  if (!isPythonUsable(VENV_PYTHON)) {
    console.error("[SidecarManager] New venv Python still not usable after recreation.");
    return null;
  }

  console.log("[SidecarManager] .venv successfully recreated.");
  return VENV_PYTHON;
}

const SIDECAR_SCRIPT = path.join(PROJECT_ROOT, "scripts", "docling_sidecar.py");
const REQUIREMENTS_FILE = path.join(PROJECT_ROOT, "scripts", "requirements-docling.txt");

/**
 * Required packages that must be importable for the sidecar to start.
 * Checked via `python -c "import <pkg>"` — if any fail, pip install runs.
 */
const REQUIRED_PACKAGES = ["fastapi", "uvicorn", "pdfplumber"];

/** Maximum time to wait for the sidecar /health to return status:ok (ms). */
const HEALTH_POLL_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;

// ── Health check ───────────────────────────────────────────────────────────

async function isHealthy(): Promise<boolean> {
  const sidecarUrl = getSidecarUrl();
  try {
    const res = await fetch(`${sidecarUrl}/health`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { status?: string; docling?: boolean };
    return json.status === "ok" || json.docling === true;
  } catch {
    return false;
  }
}

async function waitForHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

// ── Port occupation check ──────────────────────────────────────────────────

/**
 * Returns true if something is already accepting connections on the sidecar
 * port (i.e. the sidecar is already running from a previous session or
 * start_sidecar.bat).
 */
async function isPortAlreadyListening(): Promise<boolean> {
  return isHealthy();
}

// ── Dependency check & install ─────────────────────────────────────────────

/**
 * Checks whether all required Python packages are importable in the venv.
 * Returns the list of packages that are missing (empty = all present).
 */
function findMissingPackages(python: string): string[] {
  return REQUIRED_PACKAGES.filter((pkg) => {
    const result = spawnSync(python, ["-c", `import ${pkg}`], {
      encoding: "utf-8",
      timeout: 10_000,
      windowsHide: true,
    });
    return result.status !== 0;
  });
}

/**
 * Runs `pip install -r requirements-docling.txt` synchronously.
 * Returns true on success.
 */
function installDependencies(python: string): boolean {
  if (!fs.existsSync(REQUIREMENTS_FILE)) {
    console.warn(`[SidecarManager] requirements file not found: ${REQUIREMENTS_FILE}`);
    return false;
  }

  console.log("[SidecarManager] Installing missing sidecar dependencies via pip...");
  console.log(`[SidecarManager] ${python} -m pip install -r ${REQUIREMENTS_FILE}`);

  // stdio: "inherit" — pip 진행 상황을 실시간으로 터미널에 출력
  const result = spawnSync(python, ["-m", "pip", "install", "-r", REQUIREMENTS_FILE], {
    stdio: "inherit",
    // pip install can take a while — give it up to 5 minutes
    timeout: 300_000,
    windowsHide: true,
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });

  if (result.status !== 0) {
    console.error(
      `[SidecarManager] pip install failed (exit ${result.status ?? "?"}). ` +
        "Try running manually: .venv\\Scripts\\python -m pip install -r scripts\\requirements-docling.txt"
    );
    return false;
  }

  console.log("[SidecarManager] pip install completed successfully.");
  return true;
}

/**
 * Ensures all required sidecar packages are installed in the venv.
 * If any are missing, runs pip install synchronously before returning.
 * Returns false if installation failed (caller should abort spawn).
 */
function ensureDependenciesInstalled(python: string): boolean {
  const missing = findMissingPackages(python);
  if (missing.length === 0) return true;

  console.warn(
    `[SidecarManager] Missing sidecar packages: ${missing.join(", ")}. ` +
      "Running pip install automatically..."
  );

  return installDependencies(python);
}

// ── Spawn ──────────────────────────────────────────────────────────────────

function spawnSidecar(python: string): ChildProcess {
  const port = getSidecarPort();

  console.log(`[SidecarManager] Spawning Docling sidecar: ${python} ${SIDECAR_SCRIPT}`);
  console.log(`[SidecarManager] Port: ${port} | Preload model mode (DOCLING_PRELOAD_MODEL=true)`);

  const child = spawn(python, ["-X", "utf8", SIDECAR_SCRIPT], {
    env: {
      ...process.env,
      DOCLING_SIDECAR_PORT: String(port),
      // Preload models at startup so the first real /parse request is not
      // delayed by PyTorch/Docling initialization.  Sidecar startup takes
      // longer (~60s) but upload latency is significantly reduced.
      DOCLING_PRELOAD_MODEL: "true",
      PYTHONIOENCODING: "utf-8",
    },
    // Detached: false — we own the lifecycle.  stdio piped so we can log.
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: PROJECT_ROOT,
    windowsHide: true,
  });

  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");

  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) console.log(`[Docling] ${line.trim()}`);
    }
  });

  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) console.warn(`[Docling] ${line.trim()}`);
    }
  });

  child.on("error", (err) => {
    console.error(`[SidecarManager] Failed to spawn sidecar: ${err.message}`);
    console.error(
      "[SidecarManager] Ensure Python is installed and .venv exists. " +
        "Run: scripts\\start_sidecar.bat to bootstrap the environment."
    );
  });

  child.on("exit", (code, signal) => {
    const singleton = getSingleton();
    singleton.process = null;
    singleton.ready = false;
    if (code !== 0 && signal !== "SIGTERM") {
      console.warn(`[SidecarManager] Sidecar exited (code=${code ?? "?"}, signal=${signal ?? "none"})`);
    }
  });

  return child;
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

function registerShutdownHook(): void {
  const terminateSidecar = (): void => {
    const singleton = getSingleton();
    if (singleton.process && !singleton.process.killed) {
      console.log("[SidecarManager] Terminating Docling sidecar...");
      singleton.process.kill("SIGTERM");
      // Give it a moment then force-kill on Windows where SIGTERM is ignored.
      setTimeout(() => {
        if (singleton.process && !singleton.process.killed) {
          singleton.process.kill("SIGKILL");
        }
      }, 3_000);
    }
  };

  process.once("exit", terminateSidecar);
  process.once("SIGINT", () => {
    terminateSidecar();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    terminateSidecar();
    process.exit(0);
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure the Docling sidecar is running and healthy.
 *
 * - If something is already responding on the sidecar port, skips spawn.
 * - If already being started by a concurrent call (HMR), returns the
 *   in-flight promise.
 * - On failure, logs a warning and resolves (does NOT throw) so that the
 *   Next.js server continues starting up.
 */
export async function ensureSidecarRunning(): Promise<void> {
  const singleton = getSingleton();

  // Already confirmed healthy in this process session.
  if (singleton.ready) return;

  // Deduplicate concurrent calls (e.g. HMR triggers register() twice).
  if (singleton.startPromise !== null) {
    return singleton.startPromise;
  }

  singleton.startPromise = _startSidecar(singleton).finally(() => {
    // Clear the in-flight promise so future calls re-check state.
    singleton.startPromise = null;
  });

  return singleton.startPromise;
}

async function _startSidecar(singleton: SidecarGlobal): Promise<void> {
  if (singleton.starting) return;
  singleton.starting = true;

  try {
    // Check if sidecar is already reachable (e.g. started via run.bat or a
    // previous process session that attached to the same port).
    const alreadyUp = await isPortAlreadyListening();
    if (alreadyUp) {
      console.log("[SidecarManager] Docling sidecar already running — skipping spawn.");
      singleton.ready = true;
      return;
    }

    // Validate the sidecar script exists before attempting spawn.
    if (!fs.existsSync(SIDECAR_SCRIPT)) {
      console.warn(
        `[SidecarManager] Sidecar script not found at ${SIDECAR_SCRIPT}. ` +
          "Skipping auto-start. Upload will fail until sidecar is started manually."
      );
      return;
    }

    // Ensure the venv is healthy (recreate if broken) and all sidecar
    // packages are installed.  Both steps are synchronous so we never spawn
    // a process that will immediately die with ImportError / sys.exit(1).
    const python = resolveOrRepairPython();
    if (!python) {
      console.warn(
        "[SidecarManager] Could not obtain a working Python. " +
          "Install Python 3.10+ or recreate .venv manually, then restart."
      );
      return;
    }

    // If the venv was just recreated it is empty — warn that first-time install
    // of docling/torch/pdfplumber can take several minutes.
    const freshVenv = !fs.existsSync(path.join(VENV_DIR, "Lib")) &&
      !fs.existsSync(path.join(VENV_DIR, "lib"));
    if (freshVenv) {
      console.log(
        "[SidecarManager] Fresh .venv detected. Installing sidecar packages — " +
          "this may take several minutes on first run (docling + torch)."
      );
    }

    const depsOk = ensureDependenciesInstalled(python);
    if (!depsOk) {
      console.warn(
        "[SidecarManager] Dependency installation failed. " +
          "Run manually: .venv\\Scripts\\python -m pip install -r scripts\\requirements-docling.txt"
      );
      return;
    }

    singleton.process = spawnSidecar(python);
    registerShutdownHook();

    console.log(`[SidecarManager] Waiting for sidecar /health (up to ${HEALTH_POLL_TIMEOUT_MS / 1000}s)...`);
    const ready = await waitForHealthy(HEALTH_POLL_TIMEOUT_MS);

    if (ready) {
      singleton.ready = true;
      console.log("[SidecarManager] Docling sidecar is ready.");
    } else {
      console.warn(
        `[SidecarManager] Docling sidecar did not become healthy within ${HEALTH_POLL_TIMEOUT_MS / 1000}s. ` +
          "Upload will return DOCLING_UNAVAILABLE until sidecar responds. " +
          "Check sidecar logs above for Python/dependency errors."
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SidecarManager] Unexpected error during sidecar startup: ${msg}. Continuing.`);
  } finally {
    singleton.starting = false;
  }
}
