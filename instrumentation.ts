/**
 * instrumentation.ts  (Next.js 14 Instrumentation Hook)
 *
 * Executed once per server process startup — before any request handlers run.
 * Only the Node.js runtime block runs on the backend; Edge runtime is skipped.
 *
 * Auto-starts the Docling Python sidecar when:
 *   - Running in Node.js runtime (not Edge)
 *   - DOCLING_AUTO_START is not explicitly set to "false"
 *   - Not deployed on Vercel (VERCEL !== "1")
 *
 * Failures are non-fatal: the Next.js server continues starting up and uploads
 * will return DOCLING_UNAVAILABLE until the sidecar is healthy.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register(): Promise<void> {
  // Only run in the Node.js server runtime, not Edge or browser.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Skip in serverless/Vercel deployments where the sidecar cannot run.
  if (process.env.VERCEL === "1") return;

  // Allow explicit opt-out via environment variable.
  if (process.env.DOCLING_AUTO_START === "false") {
    console.log(
      "[Instrumentation] DOCLING_AUTO_START=false — skipping sidecar auto-start. " +
        "Start manually with: scripts\\start_sidecar.bat"
    );
    return;
  }

  try {
    const { ensureSidecarRunning } = await import("./lib/sidecar-manager");
    await ensureSidecarRunning();
  } catch (err) {
    // Defensive catch: should not reach here (sidecar-manager handles its own
    // errors internally), but we guard against any unexpected import failure.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Instrumentation] Sidecar auto-start encountered an error: ${msg}`);
  }
}
