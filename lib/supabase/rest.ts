/**
 * Server Component용 Supabase REST API 직접 호출 유틸리티.
 *
 * Supabase JS 클라이언트가 Next.js Server Component에서 간헐적으로
 * 빈 결과를 반환하는 문제를 회피하기 위해, PostgREST API를 직접 fetch합니다.
 */

import { getSupabaseConfig } from "../supabase-config-store";

interface RestQueryOptions {
  /** PostgREST query string (e.g. "select=id,name&order=updated_at.desc&limit=20") */
  query: string;
  /** Table name */
  table: string;
  /** Request count via Prefer header */
  count?: boolean;
  /** HEAD request (count only, no body) */
  head?: boolean;
  /** Timeout in ms (default 8000) */
  timeout?: number;
}

interface RestResult<T> {
  data: T[] | null;
  count: number | null;
  error: string | null;
}

export async function supabaseRestQuery<T>(options: RestQueryOptions): Promise<RestResult<T>> {
  const config = getSupabaseConfig();
  if (!config) return { data: null, count: null, error: "config missing" };

  const { table, query, count = false, head = false, timeout = 8_000 } = options;
  const url = `${config.url}/rest/v1/${table}?${query}`;

  const headers: Record<string, string> = {
    "apikey": config.serviceRoleKey,
    "Authorization": `Bearer ${config.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  if (count || head) {
    headers["Prefer"] = head ? "count=exact" : "count=exact";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: head ? "HEAD" : "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
    });

    clearTimeout(timer);

    if (!res.ok) {
      return { data: null, count: null, error: `HTTP ${res.status}` };
    }

    let resCount: number | null = null;
    if (count || head) {
      const range = res.headers.get("content-range");
      if (range) {
        const total = range.split("/")[1];
        if (total && total !== "*") resCount = parseInt(total, 10);
      }
    }

    if (head) {
      return { data: null, count: resCount, error: null };
    }

    const data = await res.json() as T[];
    return { data, count: resCount, error: null };
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === "AbortError") {
      return { data: null, count: null, error: "timeout" };
    }
    return { data: null, count: null, error: String(e) };
  }
}
