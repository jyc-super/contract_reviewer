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

import { spawn, type ChildProcess } from "child_process";
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

/** Resolve the Python executable to use.  Prefers the project-local venv. */
function resolvePythonExecutable(): string {
  const venvPython = path.join(PROJECT_ROOT, ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  // Fallback: system python on PATH (Unix/Linux paths too)
  const unixVenvPython = path.join(PROJECT_ROOT, ".venv", "bin", "python");
  if (fs.existsSync(unixVenvPython)) {
    return unixVenvPython;
  }
  return "python";
}

const SIDECAR_SCRIPT = path.join(PROJECT_ROOT, "scripts", "docling_sidecar.py");

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

// ── Spawn ──────────────────────────────────────────────────────────────────

function spawnSidecar(): ChildProcess {
  const python = resolvePythonExecutable();
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

    singleton.process = spawnSidecar();
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
