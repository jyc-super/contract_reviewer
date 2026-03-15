"use client";

import { useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useUploadStore } from "../../lib/stores/upload-store";

const POLL_INTERVAL_MS = 10_000;
const ACTIVE_STATUSES = new Set(["analyzing", "parsing", "filtering"]);

interface AutoRefreshWrapperProps {
  /** Status values of contracts currently displayed on the page */
  statuses: string[];
  children: React.ReactNode;
}

/**
 * Client Component wrapper that:
 * 1. On mount — always fires one `router.refresh()` to defeat stale Router Cache
 * 2. Polls `router.refresh()` every 10s when active contracts exist
 * 3. Watches upload-store's `lastCompletedContractId` for cross-page refresh
 */
export function AutoRefreshWrapper({ statuses, children }: AutoRefreshWrapperProps) {
  const router = useRouter();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasActiveContracts = statuses.some((s) => ACTIVE_STATUSES.has(s));

  // -----------------------------------------------------------------------
  // Mount refresh — always invalidate stale Router Cache on page entry
  // -----------------------------------------------------------------------
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    // Slight delay to let the initial RSC render complete before re-fetching
    const timer = setTimeout(() => {
      router.refresh();
    }, 100);
    return () => clearTimeout(timer);
  }, [router]);

  // -----------------------------------------------------------------------
  // Detect new uploads from the upload-store (cross-page state propagation)
  // -----------------------------------------------------------------------
  const lastCompletedId = useUploadStore((s) => s.lastCompletedContractId);
  const clearLastCompleted = useUploadStore((s) => s.setLastCompletedContractId);
  const consumedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!lastCompletedId) return;
    // Only consume each ID once
    if (consumedRef.current === lastCompletedId) return;
    consumedRef.current = lastCompletedId;
    // Clear the flag so it doesn't re-trigger on future mounts
    clearLastCompleted(null);
    // Force refresh so the Server Component re-fetches the contract list
    router.refresh();
  }, [lastCompletedId, clearLastCompleted, router]);

  // -----------------------------------------------------------------------
  // Periodic polling for active contracts or pending uploads
  // -----------------------------------------------------------------------
  const liveStatus = useUploadStore((s) => s.liveStatus);
  const hasPendingUpload = !!liveStatus && !["ready", "partial", "error"].includes(liveStatus);
  const shouldPoll = hasActiveContracts || hasPendingUpload;

  useEffect(() => {
    if (!shouldPoll) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Start polling
    intervalRef.current = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [shouldPoll, router]);

  // -----------------------------------------------------------------------
  // Listen for storage events from other tabs (sessionStorage changes)
  // -----------------------------------------------------------------------
  const handleStorageEvent = useCallback(
    (e: StorageEvent) => {
      if (e.key !== "upload-progress") return;
      try {
        const parsed = JSON.parse(e.newValue ?? "{}");
        const state = parsed?.state;
        if (state?.lastCompletedContractId && state.lastCompletedContractId !== consumedRef.current) {
          consumedRef.current = state.lastCompletedContractId;
          router.refresh();
        }
      } catch {
        // Ignore parse errors
      }
    },
    [router]
  );

  useEffect(() => {
    window.addEventListener("storage", handleStorageEvent);
    return () => window.removeEventListener("storage", handleStorageEvent);
  }, [handleStorageEvent]);

  return <>{children}</>;
}
