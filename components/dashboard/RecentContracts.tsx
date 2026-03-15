"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useMemo, useCallback } from "react";

export interface ContractItem {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** 페이지 수 (파싱 완료 후에만 값 있음) */
  pageCount?: number | null;
}

interface RecentContractsProps {
  items: ContractItem[];
  /** When true, shows search filter and full-list layout */
  fullList?: boolean;
  /** Current page (1-based). Only used in fullList mode. */
  currentPage?: number;
  /** Total number of pages. Only used in fullList mode. */
  totalPages?: number;
  /** Total contract count across all pages. Only used in fullList mode. */
  totalContracts?: number;
}

/* ── Status badge ── */

interface StatusInfo {
  label: string;
  bgClass: string;
  textClass: string;
  dotClass: string;
  animate?: boolean;
}

function getStatusInfo(status: string): StatusInfo {
  switch (status) {
    case "ready":
      return {
        label: "완료",
        bgClass: "bg-accent-green-dim",
        textClass: "text-accent-green",
        dotClass: "bg-accent-green",
      };
    case "analyzing":
      return {
        label: "분석 중",
        bgClass: "bg-accent-yellow-dim",
        textClass: "text-accent-yellow",
        dotClass: "bg-accent-yellow",
      };
    case "parsing":
      return {
        label: "파싱 중",
        bgClass: "bg-accent-yellow-dim",
        textClass: "text-accent-yellow",
        dotClass: "bg-accent-yellow",
        animate: true,
      };
    case "filtering":
      return {
        label: "구역 확인 대기",
        bgClass: "bg-accent-blue-dim",
        textClass: "text-accent-blue",
        dotClass: "bg-accent-blue",
        animate: true,
      };
    case "partial":
      return {
        label: "부분 분석",
        bgClass: "bg-accent-purple-dim",
        textClass: "text-accent-purple",
        dotClass: "bg-accent-purple",
      };
    case "error":
      return {
        label: "오류",
        bgClass: "bg-accent-red-dim",
        textClass: "text-accent-red",
        dotClass: "bg-accent-red",
      };
    default:
      return {
        label: status || "확인 필요",
        bgClass: "bg-accent-yellow-dim",
        textClass: "text-accent-yellow",
        dotClass: "bg-accent-yellow",
      };
  }
}

function StatusBadge({ status }: { status: string }) {
  const info = getStatusInfo(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${info.bgClass} ${info.textClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${info.dotClass} ${info.animate ? "animate-pulse" : ""}`}
      />
      {info.label}
    </span>
  );
}

/* ── Status filter tabs ── */

const STATUS_FILTERS = [
  { key: "all", label: "전체" },
  { key: "ready", label: "완료" },
  { key: "in_progress", label: "진행 중" },
  { key: "error", label: "오류" },
] as const;

type StatusFilterKey = (typeof STATUS_FILTERS)[number]["key"];

function isInProgress(status: string): boolean {
  return status === "analyzing" || status === "parsing" || status === "filtering" || status === "partial";
}

/* ── Main component ── */

export function RecentContracts({
  items,
  fullList = false,
  currentPage = 1,
  totalPages = 1,
  totalContracts,
}: RecentContractsProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  const handleDeleteClick = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setConfirmId(id);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!confirmId) return;
    const targetId = confirmId;

    if (deletingId || deletedIds.has(targetId)) {
      setConfirmId(null);
      return;
    }

    setDeletingId(targetId);
    setConfirmId(null);

    // 낙관적 업데이트: 즉시 목록에서 제거
    setDeletedIds((prev) => new Set([...prev, targetId]));

    try {
      const res = await fetch(`/api/contracts/${targetId}`, { method: "DELETE" });
      const body = await res.json().catch(() => null);

      if (!res.ok && !body?.alreadyDeleted) {
        // 삭제 실패 → 낙관적 업데이트 롤백
        setDeletedIds((prev) => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
        alert(body?.error ?? "삭제 중 오류가 발생했습니다.");
      } else {
        // 삭제 성공 → 서버 데이터 갱신
        router.refresh();
      }
    } catch {
      // 네트워크 에러 → 롤백
      setDeletedIds((prev) => {
        const next = new Set(prev);
        next.delete(targetId);
        return next;
      });
      alert("네트워크 오류가 발생했습니다.");
    } finally {
      setDeletingId(null);
    }
  }, [confirmId, deletingId, deletedIds, router]);

  const filtered = useMemo(() => {
    let result = items.filter((item) => !deletedIds.has(item.id));

    if (statusFilter !== "all") {
      result = result.filter((item) => {
        if (statusFilter === "in_progress") return isInProgress(item.status);
        return item.status === statusFilter;
      });
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((item) => item.name.toLowerCase().includes(q));
    }

    return result;
  }, [items, search, statusFilter, deletedIds]);

  // Count per status for filter tabs
  const counts = useMemo(() => {
    const visibleItems = items.filter((i) => !deletedIds.has(i.id));
    const all = visibleItems.length;
    const ready = visibleItems.filter((i) => i.status === "ready").length;
    const inProgress = visibleItems.filter((i) => isInProgress(i.status)).length;
    const error = visibleItems.filter((i) => i.status === "error").length;
    return { all, ready, in_progress: inProgress, error };
  }, [items, deletedIds]);

  /* ── Empty state ── */
  if (!items.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-bg-tertiary">
          <svg
            className="h-6 w-6 text-text-muted"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
            />
          </svg>
        </div>
        <p className="text-sm font-medium text-text-secondary">
          등록된 계약이 없습니다
        </p>
        <p className="mt-1 text-xs text-text-muted">
          계약서를 업로드하면 여기에 표시됩니다
        </p>
        <Link
          href="/upload"
          className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-accent-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-blue/80"
        >
          계약서 업로드
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Search + filter bar (only in full list mode) */}
      {fullList && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* Search */}
          <div className="relative w-full sm:max-w-xs">
            <svg
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="계약서명 검색..."
              className="h-9 w-full rounded-md border border-border-muted bg-bg-secondary pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-blue focus:outline-none focus:ring-1 focus:ring-accent-blue"
            />
          </div>

          {/* Status filter tabs */}
          <div className="flex gap-1 rounded-lg bg-bg-secondary p-1">
            {STATUS_FILTERS.map((f) => {
              const count = counts[f.key];
              const isActive = statusFilter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-bg-hover text-text-primary"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {f.label}
                  <span
                    className={`ml-1.5 ${isActive ? "text-text-secondary" : "text-text-muted"}`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border-muted">
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                계약서명
              </th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                상태
              </th>
              {fullList && (
                <th className="hidden px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted sm:table-cell">
                  등록일
                </th>
              )}
              {fullList && (
                <th className="hidden px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-text-muted lg:table-cell">
                  페이지
                </th>
              )}
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                업데이트
              </th>
              <th className="w-10 px-2 py-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const href =
                item.status === "filtering"
                  ? `/contracts/${item.id}/zones`
                  : `/contracts/${item.id}`;
              const isItemDeleting = deletingId === item.id;
              return (
              <tr
                key={item.id}
                className="group cursor-pointer border-b border-border-muted/50 transition-colors last:border-b-0 hover:bg-bg-hover"
                onClick={() => router.push(href)}
              >
                <td className="px-4 py-3.5">
                  <Link
                    href={href}
                    className="block font-medium text-text-primary transition-colors group-hover:text-accent-blue"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.name}
                  </Link>
                </td>
                <td className="px-4 py-3.5">
                  <StatusBadge status={item.status} />
                </td>
                {fullList && (
                  <td className="hidden px-4 py-3.5 text-xs text-text-muted sm:table-cell">
                    {item.createdAt}
                  </td>
                )}
                {fullList && (
                  <td className="hidden px-4 py-3.5 text-right text-xs text-text-muted lg:table-cell">
                    {item.pageCount != null ? `${item.pageCount}p` : "—"}
                  </td>
                )}
                <td className="px-4 py-3.5 text-xs text-text-muted">
                  {item.updatedAt}
                </td>
                <td className="px-2 py-3.5 text-right">
                  <button
                    onClick={(e) => handleDeleteClick(e, item.id)}
                    disabled={isItemDeleting}
                    className="rounded p-1.5 text-text-muted opacity-0 transition-all group-hover:opacity-100 hover:bg-accent-red-dim hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                    title="삭제"
                    aria-label={`${item.name} 삭제`}
                  >
                    {isItemDeleting ? (
                      <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    )}
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* No results from filter/search */}
      {filtered.length === 0 && items.length > 0 && (
        <div className="flex flex-col items-center py-10 text-center">
          <p className="text-sm text-text-secondary">
            검색 결과가 없습니다
          </p>
          <button
            onClick={() => {
              setSearch("");
              setStatusFilter("all");
            }}
            className="mt-2 text-xs text-accent-blue hover:underline"
          >
            필터 초기화
          </button>
        </div>
      )}

      {/* Result count footer */}
      {fullList && filtered.length > 0 && (
        <p className="text-xs text-text-muted">
          {totalContracts != null && totalContracts > items.length
            ? `전체 ${totalContracts}건 중 ${filtered.length}건 표시`
            : filtered.length === items.length
              ? `총 ${items.length}건`
              : `${items.length}건 중 ${filtered.length}건 표시`}
        </p>
      )}

      {/* Pagination controls (fullList mode only) */}
      {fullList && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Link
            href={currentPage > 1 ? `/contracts?page=${currentPage - 1}` : "#"}
            className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              currentPage > 1
                ? "bg-bg-secondary text-text-primary hover:bg-bg-hover"
                : "pointer-events-none bg-bg-secondary/50 text-text-muted"
            }`}
            aria-disabled={currentPage <= 1}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            이전
          </Link>

          <span className="text-sm text-text-secondary">
            {currentPage} / {totalPages}
          </span>

          <Link
            href={currentPage < totalPages ? `/contracts?page=${currentPage + 1}` : "#"}
            className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              currentPage < totalPages
                ? "bg-bg-secondary text-text-primary hover:bg-bg-hover"
                : "pointer-events-none bg-bg-secondary/50 text-text-muted"
            }`}
            aria-disabled={currentPage >= totalPages}
          >
            다음
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </Link>
        </div>
      )}

      {/* 삭제 확인 모달 */}
      {confirmId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setConfirmId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            className="mx-4 w-full max-w-sm rounded-xl border border-border-muted bg-bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-red-dim">
              <svg className="h-6 w-6 text-accent-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </div>
            <h3 id="delete-dialog-title" className="mb-1 text-base font-semibold text-text-primary">계약서 삭제</h3>
            <p className="mb-5 text-sm text-text-secondary">
              이 계약서와 관련된 모든 분석 데이터가 영구적으로 삭제됩니다. 되돌릴 수 없습니다.
            </p>
            <div className="flex gap-3">
              <button
                autoFocus
                onClick={() => setConfirmId(null)}
                className="flex-1 rounded-md border border-border-muted bg-bg-secondary px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover"
              >
                취소
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="flex-1 rounded-md bg-accent-red px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-red/80"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
