import { NextRequest, NextResponse } from "next/server";
import { processContract } from "../../../lib/pipeline/process-contract";
import { DocumentParseError } from "../../../lib/document-parser";
import { DoclingParseError } from "../../../lib/docling-adapter";
import { getAdminSupabaseClientIfAvailable } from "../../../lib/supabase/admin";
import { requireUserIdFromRequest } from "../../../lib/auth/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as logger from "../../../lib/logger";
import type { ProcessContractResult } from "../../../lib/pipeline/process-contract";

// ---------------------------------------------------------------------------
// GET /api/contracts — list contracts with pagination and sorting
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireUserIdFromRequest(req);
    if ("response" in auth) return auth.response;

    const supabase = getAdminSupabaseClientIfAvailable();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: "Supabase is not configured." },
        { status: 503 }
      );
    }

    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
    const offset = (page - 1) * limit;

    const sortParam = url.searchParams.get("sort");
    const sort =
      sortParam === "created_at" || sortParam === "name" || sortParam === "status"
        ? sortParam
        : "updated_at";
    const ascending = url.searchParams.get("order") === "asc";

    const QUERY_TIMEOUT_MS = 8_000;

    const result = await Promise.race([
      supabase
        .from("contracts")
        .select("id, name, status, created_at, updated_at, page_count", { count: "exact" })
        .order(sort, { ascending })
        .range(offset, offset + limit - 1) as unknown as Promise<{
          data: { id: string; name: string; status: string; created_at: string; updated_at: string; page_count: number | null }[] | null;
          count: number | null;
          error: { message?: string } | null;
        }>,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), QUERY_TIMEOUT_MS)),
    ]);

    if (result === "timeout") {
      return NextResponse.json(
        { ok: false, error: "Query timed out." },
        { status: 504 }
      );
    }

    if (result.error) {
      logger.error("[contracts/route] GET: query failed", result.error as unknown as Error);
      return NextResponse.json(
        { ok: false, error: "Failed to query contracts." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      contracts: result.data ?? [],
      totalContracts: result.count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    logger.error(
      "[contracts/route] GET: unhandled error",
      err instanceof Error ? err : new Error(String(err))
    );
    return NextResponse.json(
      { ok: false, error: "Unexpected error." },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Async (202) upload strategy
//
// The Docling sidecar can take 3–10+ minutes to parse a large PDF (batched
// processing, Windows Defender DLL scan, model init).  Rather than holding
// the HTTP connection open and risking a gateway/platform timeout, we:
//
//  1. Validate the file (type, size).
//  2. Insert a contract row with status="parsing" and return 202 immediately.
//  3. Run processContract() + all DB inserts in the background.
//  4. Update the contract row to status="ready"|"filtering"|"error" when done.
//
// The client polls GET /api/contracts/[id]/status to learn when parsing is
// complete.  This route already exists and is unchanged.
//
// On Vercel Hobby the platform caps functions at 60s regardless; the async
// approach does NOT fix Vercel — the background work will be killed with the
// function.  Vercel users must pre-warm the sidecar and keep PDFs small.
// Local dev (npm run dev) benefits fully: Node.js keeps the process alive for
// in-flight promises even after the response is sent.
// ---------------------------------------------------------------------------

function isSchemaMissingError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  const message = error.message ?? "";
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    message.includes("Could not find the table") ||
    message.includes("schema cache")
  );
}

// ---------------------------------------------------------------------------
// Background DB write — called after 202 is already sent.
// Updates the contract row to the final status once parsing completes.
// ---------------------------------------------------------------------------

async function persistParseResult(
  supabase: SupabaseClient,
  contractId: string,
  result: ProcessContractResult,
  onProgress?: (percent: number) => void
): Promise<void> {
  const persistStart = Date.now();
  logger.info("[contracts/route] persistParseResult: start", { contractId });

  // 1. Update top-level contract fields resolved during parsing.
  // parse_progress is reset to null here — the parsing phase is complete
  // and the client should transition to the next status-based stage.
  const { error: updateError } = await supabase
    .from("contracts")
    .update({
      status: result.uncertainZoneCount > 0 ? "filtering" : "ready",
      page_count: result.pages,
      source_languages: result.sourceLanguages?.length ? result.sourceLanguages : null,
      parse_progress: null,
      updated_at: new Date().toISOString(),
      document_parts: result.documentParts ?? null,
      header_footer_info: result.headerFooterInfo ?? null,
      toc_entries: result.tocEntries ?? null,
      // sub_documents requires migration 008_add_sub_documents.sql to be applied first.
      // Once the migration is in place, this line is active automatically.
      sub_documents: result.subDocuments ?? null,
    })
    .eq("id", contractId);

  if (updateError) {
    logger.error("[contracts/route] persistParseResult: contract update failed", updateError as Error);
    // Still attempt zone/clause insert — partial data is better than none
  }

  const analysisZones = result.zones.filter((z) => z.isAnalysisTarget);
  const uncertainZones = result.zones.filter((z) => !z.isAnalysisTarget);

  // 2. Insert all zones (analysis + uncertain) in one shot.
  // Previously only analysis zones were inserted, causing an early return when
  // all zones were uncertain (is_analysis_target=false), which meant nothing was
  // written to document_zones or clauses at all.
  const allZonesToInsert = result.zones;
  if (allZonesToInsert.length === 0) {
    logger.warn("[contracts/route] persistParseResult: no zones at all, skipping zone/clause insert", { contractId });
    return;
  }

  // Chunk zones insert to avoid PostgREST payload size limits on large documents
  const ZONE_CHUNK_SIZE = 100;
  const zoneRows = allZonesToInsert.map((z) => ({
    contract_id: contractId,
    page_from: z.pageFrom,
    page_to: z.pageTo,
    zone_type: z.zoneType,
    confidence: z.confidence,
    is_analysis_target: z.isAnalysisTarget,
    text: z.text,
  }));

  const insertedZoneRows: { id: string }[] = [];
  for (let i = 0; i < zoneRows.length; i += ZONE_CHUNK_SIZE) {
    const chunk = zoneRows.slice(i, i + ZONE_CHUNK_SIZE);
    const { data: chunkData, error: chunkError } = await supabase
      .from("document_zones")
      .insert(chunk)
      .select("id");

    if (chunkError) {
      logger.error("[contracts/route] persistParseResult: document_zones insert failed", {
        contractId,
        chunkStart: i,
        chunkSize: chunk.length,
        code: (chunkError as { code?: string }).code,
        message: (chunkError as { message?: string }).message,
      } as unknown as Error);
      // Mark contract as error so the polling client stops waiting.
      await supabase
        .from("contracts")
        .update({ status: "error", parse_progress: null, updated_at: new Date().toISOString() })
        .eq("id", contractId)
        .then(({ error: e }) => {
          if (e) logger.error("[contracts/route] persistParseResult: could not set error status after zones insert failure", e as Error);
        });
      return;
    }
    insertedZoneRows.push(...(chunkData ?? []));
  }
  // Build a map from the original zone index (in result.zones order) to the
  // inserted Supabase UUID, so clause zoneIndex references resolve correctly.
  // zoneIndex in ClauseForDb is an index into result.zones (all zones, in order),
  // and insertedZoneRows preserves that same order.
  const zoneIndexToId = new Map<number, string>(
    insertedZoneRows.map((r: { id: string }, i: number) => [i, r.id])
  );

  logger.info("[contracts/route] persistParseResult: zones inserted", {
    contractId,
    total: insertedZoneRows.length,
    analysis: analysisZones.length,
    uncertain: uncertainZones.length,
  });
  onProgress?.(95);

  // 3. Insert clauses
  // zoneIndex in ClauseForDb is an index into result.zones (all zones).
  // Resolve it to the Supabase UUID via zoneIndexToId; fall back to index 0.
  if (result.clauses.length > 0 && insertedZoneRows.length > 0) {
    const CLAUSE_CHUNK_SIZE = 100;
    const clauseRows = result.clauses.map((c, clauseIndex) => {
      const zoneId = zoneIndexToId.get(c.zoneIndex) ?? zoneIndexToId.get(0);
      return {
        contract_id: contractId,
        zone_id: zoneId,
        title: c.title ?? null,
        number: c.number ?? null,
        parent_clause_number: c.parentNumber ?? null,
        text: c.text,
        is_auto_split: c.isAutoSplit,
        needs_review: c.needsReview,
        content_hash: c.contentHash ?? null,
        sort_order: clauseIndex,
        zone_key: c.zoneKey ?? null,
        content_format: c.contentFormat ?? "plain",
      };
    });

    for (let i = 0; i < clauseRows.length; i += CLAUSE_CHUNK_SIZE) {
      const chunk = clauseRows.slice(i, i + CLAUSE_CHUNK_SIZE);
      const { error: clausesError } = await supabase.from("clauses").insert(chunk);
      if (clausesError) {
        logger.error("[contracts/route] persistParseResult: clauses insert failed", {
          contractId,
          chunkStart: i,
          chunkSize: chunk.length,
          code: (clausesError as { code?: string }).code,
          message: (clausesError as { message?: string }).message,
        } as unknown as Error);
        // Clause insert failure is non-fatal for the zone data already written
        break;
      }
    }
  }

  onProgress?.(98);

  const elapsed = Date.now() - persistStart;
  logger.info("[contracts/route] persistParseResult: done", { contractId, elapsedMs: elapsed });
}

// ---------------------------------------------------------------------------
// Background parse + persist — floats as an unresolved Promise after 202.
// In Node.js the event loop stays alive until all microtasks settle; the
// Docling parse will complete and the DB will be updated even though the
// HTTP response has already been sent.
// ---------------------------------------------------------------------------

/**
 * Build a throttled onProgress callback that writes parse_progress to the DB.
 *
 * Throttle rationale: Docling parse can emit rapid progress ticks.  We cap
 * DB writes to one per THROTTLE_MS to avoid hammering Supabase Free Tier
 * with dozens of tiny UPDATE calls during what is already a CPU-heavy parse.
 *
 * The callback is fire-and-forget — a failed DB write is logged but never
 * bubbles up to the caller, so a transient Supabase hiccup cannot abort an
 * otherwise healthy parse.
 */
function makeProgressUpdater(
  supabase: SupabaseClient,
  contractId: string,
  THROTTLE_MS = 3_000
): (percent: number) => void {
  let lastWrittenAt = 0;
  let lastPercent = -1;

  return (percent: number): void => {
    // Skip if the value hasn't changed (avoids redundant updates)
    if (percent === lastPercent) return;

    const now = Date.now();
    if (now - lastWrittenAt < THROTTLE_MS) return;

    lastWrittenAt = now;
    lastPercent = percent;

    // Fire-and-forget: do NOT await inside the onProgress callback.
    // This keeps the callback synchronous from the caller's perspective
    // and avoids adding latency to the parse pipeline.
    void supabase
      .from("contracts")
      .update({ parse_progress: percent, updated_at: new Date().toISOString() })
      .eq("id", contractId)
      .then(({ error }) => {
        if (error) {
          logger.warn("[contracts/route] parse_progress update failed (non-fatal)", {
            contractId,
            percent,
            error: (error as { message?: string }).message ?? String(error),
          });
        } else {
          logger.info("[contracts/route] parse_progress updated", { contractId, percent });
        }
      });
  };
}

async function runParseAndPersist(
  supabase: SupabaseClient,
  contractId: string,
  file: File
): Promise<void> {
  const runStart = Date.now();
  logger.info("[contracts/route] runParseAndPersist: start", {
    contractId,
    fileName: file.name,
    fileSize: file.size,
  });

  const onProgress = makeProgressUpdater(supabase, contractId);

  // Callback invoked by processContract() immediately before qualityCheck().
  // Transitions the DB status to "quality_checking" so the polling client can
  // display a distinct pipeline stage for this step.
  // This is awaited inside the pipeline to guarantee ordering — the DB write
  // completes before qualityCheck() begins.
  const onQualityCheckStart = async (): Promise<void> => {
    const { error } = await supabase
      .from("contracts")
      .update({ status: "quality_checking", updated_at: new Date().toISOString() })
      .eq("id", contractId);
    if (error) {
      logger.warn("[contracts/route] onQualityCheckStart: status update failed (non-fatal)", {
        contractId,
        error: (error as { message?: string }).message ?? String(error),
      });
    } else {
      logger.info("[contracts/route] onQualityCheckStart: status set to quality_checking", { contractId });
    }
  };

  let result: ProcessContractResult;
  try {
    result = await processContract(file, { onProgress, onQualityCheckStart });
    const elapsed = Date.now() - runStart;
    logger.info("[contracts/route] runParseAndPersist: processContract done", {
      contractId,
      elapsedMs: elapsed,
      pages: result.pages,
      clauses: result.clauseCount,
      zones: result.zones.length,
    });
  } catch (err) {
    const elapsed = Date.now() - runStart;
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof DocumentParseError || err instanceof DoclingParseError
        ? (err as { code: string }).code
        : "PARSE_FAILED";

    logger.error("[contracts/route] runParseAndPersist: processContract failed", {
      contractId,
      elapsedMs: elapsed,
      code,
      message,
    } as unknown as Error);

    // Mark contract as error so the polling client can stop.
    // We include the error code and message in the log so the original
    // parse failure is not silently swallowed if the DB update also fails.
    const { error: updateError } = await supabase
      .from("contracts")
      .update({
        status: "error",
        parse_progress: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", contractId);

    if (updateError) {
      logger.error("[contracts/route] runParseAndPersist: failed to mark contract as error", {
        contractId,
        originalParseCode: code,
        originalParseMessage: message,
        supabaseUpdateError: (updateError as { message?: string }).message ?? String(updateError),
      } as unknown as Error);
    }
    return;
  }

  // Signal that parsing is done and DB writes are in progress (90%)
  onProgress(90);

  try {
    await persistParseResult(supabase, contractId, result, onProgress);
    // parse_progress is reset to null by persistParseResult's final status
    // update (status="ready"|"filtering" already contains parse_progress: null).
  } catch (err) {
    logger.error("[contracts/route] runParseAndPersist: persistParseResult threw", err instanceof Error ? err : new Error(String(err)));

    // Best-effort: try to flip the contract to error
    await supabase
      .from("contracts")
      .update({ status: "error", parse_progress: null, updated_at: new Date().toISOString() })
      .eq("id", contractId)
      .then(({ error: e }) => {
        if (e) logger.error("[contracts/route] runParseAndPersist: could not set error status", e as Error);
      });
  }
}

// ---------------------------------------------------------------------------
// POST /api/contracts
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireUserIdFromRequest(req);
    if ("response" in auth) return auth.response;
    const { userId } = auth;

    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "File is required." },
        { status: 400 }
      );
    }

    // Basic file type guard before any heavy work
    const nameLower = file.name.toLowerCase();
    if (!nameLower.endsWith(".pdf") && !nameLower.endsWith(".docx")) {
      return NextResponse.json(
        { ok: false, error: "Unsupported file format. Only PDF or DOCX can be uploaded." },
        { status: 400 }
      );
    }

    const supabase = getAdminSupabaseClientIfAvailable();

    // ---------------------------------------------------------------------------
    // Path A: Supabase is configured — async 202 flow
    // ---------------------------------------------------------------------------
    if (supabase) {
      // Insert a placeholder row immediately so the client can start polling.
      // Race the insert against a 5-second deadline.  Without this, a
      // misconfigured or stopped Supabase instance causes a ~600s TCP hang.
      type InsertResult = { data: { id: string } | null; error: { code?: string; message?: string } | null };
      const insertWithTimeout: Promise<InsertResult | "timeout"> = Promise.race([
        supabase
          .from("contracts")
          .insert({
            user_id: userId,
            name: file.name,
            status: "parsing",
            // page_count and source_languages will be set after parsing completes
          })
          .select("id")
          .single() as unknown as Promise<InsertResult>,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
      ]);

      const insertOutcome = await insertWithTimeout;

      if (insertOutcome === "timeout") {
        logger.error("[contracts/route] POST: initial contract insert timed out (Supabase unreachable)", new Error("insert timeout"));
        return NextResponse.json(
          { ok: false, error: "Supabase is unreachable. Check your Supabase URL and ensure the instance is running.", code: "SUPABASE_UNREACHABLE" },
          { status: 503 }
        );
      }

      const { data: row, error: insertError } = insertOutcome;

      if (insertError) {
        logger.error("[contracts/route] POST: initial contract insert failed", insertError as Error);

        if (isSchemaMissingError(insertError as { code?: string; message?: string })) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "Supabase schema is not initialized. Run migrations: 001_init_core_tables.sql, 002_rls_policies.sql, 003_app_settings.sql.",
              code: "SUPABASE_SCHEMA_MISSING",
            },
            { status: 503 }
          );
        }

        // Surface RLS violations and other auth-level rejections distinctly so
        // operators can distinguish a misconfigured service-role key from a
        // transient network error.
        const pgCode = (insertError as { code?: string }).code ?? "";
        const pgMessage = (insertError as { message?: string }).message ?? "";
        if (pgCode === "42501" || pgMessage.toLowerCase().includes("permission denied")) {
          return NextResponse.json(
            {
              ok: false,
              error: "Supabase rejected the insert due to insufficient permissions. Check your Service Role Key and RLS policies.",
              code: "SUPABASE_PERMISSION_DENIED",
            },
            { status: 503 }
          );
        }

        return NextResponse.json(
          {
            ok: false,
            error: "Failed to create contract record in Supabase. Check connection and credentials.",
            code: "SUPABASE_INSERT_FAILED",
          },
          { status: 503 }
        );
      }

      if (!row?.id) {
        logger.error("[contracts/route] POST: insert returned no id", new Error("row is null after insert"));
        return NextResponse.json(
          { ok: false, error: "Failed to create contract record." },
          { status: 500 }
        );
      }
      const contractId = row.id;
      logger.info("[contracts/route] POST: contract row created, starting background parse", {
        contractId,
        fileName: file.name,
        fileSize: file.size,
      });

      // Fire-and-forget: do NOT await.  The parse + DB persist continues in
      // the background after 202 is returned to the client.
      // Unhandled promise rejections are caught inside runParseAndPersist.
      void runParseAndPersist(supabase, contractId, file);

      return NextResponse.json(
        {
          ok: true,
          contractId,
          status: "parsing",
          message: "Contract upload accepted. Poll /api/contracts/{id}/status for completion.",
        },
        { status: 202 }
      );
    }

    // ---------------------------------------------------------------------------
    // Path B: No Supabase — synchronous parse, return result inline (dev mode)
    // ---------------------------------------------------------------------------
    logger.warn("[contracts/route] POST: Supabase not configured, running synchronous parse");

    const SYNC_TIMEOUT_MS = process.env.VERCEL === "1" ? 55_000 : 600_000;

    const result = await Promise.race([
      processContract(file),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Processing timeout after ${SYNC_TIMEOUT_MS / 1000}s`)),
          SYNC_TIMEOUT_MS
        )
      ),
    ]);

    return NextResponse.json(
      {
        ok: true,
        data: result,
      },
      { status: 200 }
    );
  } catch (err) {
    logger.error(
      "[contracts/route] POST: unhandled error",
      err instanceof Error ? err : new Error(String(err))
    );

    const message =
      err instanceof Error
        ? err.message
        : "Unexpected error while processing contract upload.";

    if (err instanceof DocumentParseError || err instanceof DoclingParseError) {
      const code = (err as { code: string }).code;
      const doclingMessage =
        code === "DOCLING_UNAVAILABLE"
          ? "Docling sidecar is not ready. Prepare the sidecar and retry upload."
          : "Docling failed to parse this file. Prepare/restart the sidecar, then retry upload.";
      return NextResponse.json(
        {
          ok: false,
          code,
          message: doclingMessage,
          error: doclingMessage,
        },
        { status: 503 }
      );
    }

    const isTimeout = message.toLowerCase().includes("timeout");
    return NextResponse.json(
      { ok: false, error: message },
      { status: isTimeout ? 504 : 500 }
    );
  }
}
