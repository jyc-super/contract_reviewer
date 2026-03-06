import { NextRequest, NextResponse } from "next/server";
import { processContract } from "../../../lib/pipeline/process-contract";
import { getAdminSupabaseClientIfAvailable } from "../../../lib/supabase/admin";
import { getUserIdFromRequest, PLACEHOLDER_USER_ID } from "../../../lib/auth/server";
import * as logger from "../../../lib/logger";

const PROCESS_CONTRACT_TIMEOUT_MS = 300_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("전처리 시간이 초과되었습니다. 문서 크기를 확인하거나 잠시 후 다시 시도해 주세요."));
    }, ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

export async function POST(req: NextRequest) {
  try {
    const userId = (await getUserIdFromRequest(req)) ?? PLACEHOLDER_USER_ID;

    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "파일이 첨부되지 않았습니다." },
        { status: 400 }
      );
    }

    const result = await withTimeout(
      processContract(file),
      PROCESS_CONTRACT_TIMEOUT_MS
    );

    let contractId: string | undefined;

    const supabase = getAdminSupabaseClientIfAvailable();
    if (supabase) {
      const { data: row, error } = await supabase
        .from("contracts")
        .insert({
          user_id: userId,
          name: file.name,
          status:
            result.uncertainZoneCount > 0 ? "filtering" : "ready",
          page_count: result.pages,
          source_languages: result.sourceLanguages?.length ? result.sourceLanguages : null,
        })
        .select("id")
        .single();

      if (error) {
        logger.error("contracts insert error", error as Error);
        return NextResponse.json(
          { ok: false, error: "계약 저장에 실패했습니다." },
          { status: 500 }
        );
      }

      if (row?.id) {
        contractId = row.id;

        const analysisZones = result.zones.filter((z) => z.isAnalysisTarget);
        const uncertainZones = result.zones.filter((z) => !z.isAnalysisTarget);

        if (analysisZones.length > 0) {
          const { data: insertedZones, error: zonesError } = await supabase
            .from("document_zones")
            .insert(
              analysisZones.map((z) => ({
                contract_id: contractId,
                page_from: z.pageFrom,
                page_to: z.pageTo,
                zone_type: z.zoneType,
                confidence: z.confidence,
                is_analysis_target: true,
                text: z.text,
              }))
            )
            .select("id");

          if (zonesError) {
            logger.error("document_zones insert error", zonesError as Error);
            return NextResponse.json(
              { ok: false, error: "구역 저장에 실패했습니다." },
              { status: 500 }
            );
          }

          const zoneIds = (insertedZones ?? []).map((r) => r.id);

          if (uncertainZones.length > 0) {
            const { error: uncertainZonesError } = await supabase.from("document_zones").insert(
              uncertainZones.map((z) => ({
                contract_id: contractId,
                page_from: z.pageFrom,
                page_to: z.pageTo,
                zone_type: z.zoneType,
                confidence: z.confidence,
                is_analysis_target: false,
                text: z.text,
              }))
            );
            if (uncertainZonesError) {
              logger.error("document_zones uncertain insert error", uncertainZonesError as Error);
              return NextResponse.json(
                { ok: false, error: "구역 저장에 실패했습니다." },
                { status: 500 }
              );
            }
          }

          if (result.clauses.length > 0 && zoneIds.length > 0) {
            const { error: clausesError } = await supabase.from("clauses").insert(
              result.clauses.map((c) => {
                const zoneId = zoneIds[c.zoneIndex] ?? zoneIds[0];
                return {
                  contract_id: contractId,
                  zone_id: zoneId,
                  title: c.title ?? null,
                  number: c.number ?? null,
                  text: c.text,
                  is_auto_split: c.isAutoSplit,
                  needs_review: c.needsReview,
                  content_hash: c.contentHash ?? null,
                };
              })
            );
            if (clausesError) {
              logger.error("clauses insert error", clausesError as Error);
              return NextResponse.json(
                { ok: false, error: "조항 저장에 실패했습니다." },
                { status: 500 }
              );
            }
          }
        }
      }
    }

    return NextResponse.json(
      {
        ok: true,
        data: result,
        ...(contractId && { contractId }),
      },
      { status: 200 }
    );
  } catch (err) {
    logger.error("계약서 업로드 처리 중 오류", err instanceof Error ? err : new Error(String(err)));
    const message =
      err instanceof Error ? err.message : "계약서 업로드 처리 중 오류가 발생했습니다.";
    const isTimeout = message.includes("시간이 초과");
    const isValidationError =
      message.includes("지원되지 않는") ||
      message.includes("용량") ||
      message.includes("파일이 첨부");
    return NextResponse.json(
      { ok: false, error: message },
      { status: isTimeout ? 504 : isValidationError ? 400 : 500 }
    );
  }
}

