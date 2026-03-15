import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Upload progress store — persisted to sessionStorage so navigating away
// from the upload page and returning preserves the current upload state.
// ---------------------------------------------------------------------------

export interface UploadProgressState {
  /** Pipeline stage 1–6. Defaults to 0 when idle (no upload started). */
  stage: number;
  /** Supabase contract row id (async 202 path). */
  contractId: string | null;
  /** Server-side status string: parsing | filtering | analyzing | ready | partial | error */
  liveStatus: string | null;
  /** Original file name shown in progress UI. */
  fileName: string | null;
  /** Uploaded file size in bytes — used for dynamic ETA estimation. */
  fileSize: number | null;
  /** User-facing error message. */
  error: string | null;
  /** Machine-readable error code (e.g. DOCLING_UNAVAILABLE). */
  errorCode: string | null;
  /** Timestamp (ms) when the upload started — used for elapsed time display. */
  startTime: number | null;
  /**
   * Granular parse progress (0–100) from the DB during status=parsing.
   * Null when not in the parsing phase.
   * Used to drive smooth progress bar movement instead of holding at a fixed 33%.
   */
  parseProgress: number | null;
  /**
   * Contract ID that was most recently uploaded and reached a terminal state
   * (ready/partial/filtering). Read by AutoRefreshWrapper to trigger a forced
   * refresh on the contracts list page so newly-uploaded contracts appear
   * without a full page reload.  Cleared after the list page consumes it.
   */
  lastCompletedContractId: string | null;
}

interface UploadProgressActions {
  setStage: (stage: number) => void;
  /** Advance stage only if the new value is higher than the current one. */
  advanceStage: (stage: number) => void;
  setContractId: (id: string) => void;
  setLiveStatus: (status: string | null) => void;
  setFileName: (name: string | null) => void;
  setFileSize: (size: number | null) => void;
  setError: (error: string | null, errorCode?: string | null) => void;
  setStartTime: (time: number | null) => void;
  setParseProgress: (progress: number | null) => void;
  setLastCompletedContractId: (id: string | null) => void;
  /** Reset all fields — call when starting a new upload. */
  reset: () => void;
}

export type UploadStore = UploadProgressState & UploadProgressActions;

const INITIAL_STATE: UploadProgressState = {
  stage: 0,
  contractId: null,
  liveStatus: null,
  fileName: null,
  fileSize: null,
  error: null,
  errorCode: null,
  startTime: null,
  parseProgress: null,
  lastCompletedContractId: null,
};

export const useUploadStore = create<UploadStore>()(
  persist(
    (set) => ({
      ...INITIAL_STATE,

      setStage: (stage) => set({ stage }),
      advanceStage: (stage) =>
        set((s) => ({ stage: Math.max(s.stage, stage) })),
      setContractId: (id) => set({ contractId: id }),
      setLiveStatus: (status) => set({ liveStatus: status }),
      setFileName: (name) => set({ fileName: name }),
      setFileSize: (size) => set({ fileSize: size }),
      setError: (error, errorCode) =>
        set({ error, errorCode: errorCode ?? null }),
      setStartTime: (time) => set({ startTime: time }),
      setParseProgress: (progress) => set({ parseProgress: progress }),
      setLastCompletedContractId: (id) => set({ lastCompletedContractId: id }),
      reset: () => set({ ...INITIAL_STATE, lastCompletedContractId: null }),
    }),
    {
      name: "upload-progress",
      storage: createJSONStorage(() => sessionStorage),
      // Only persist the state fields, not the action functions.
      partialize: (state) => ({
        stage: state.stage,
        contractId: state.contractId,
        liveStatus: state.liveStatus,
        fileName: state.fileName,
        fileSize: state.fileSize,
        error: state.error,
        errorCode: state.errorCode,
        startTime: state.startTime,
        parseProgress: state.parseProgress,
        lastCompletedContractId: state.lastCompletedContractId,
      }),
    }
  )
);
