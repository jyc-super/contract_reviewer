"use client";

import Link from "next/link";

interface RecentContract {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
}

interface RecentContractsProps {
  items: RecentContract[];
}

function statusBadge(status: string) {
  const map: Record<string, { cls: string; label: string }> = {
    ready: { cls: "badge-done", label: "✓ 완료" },
    analyzing: { cls: "badge-analyzing", label: "⟳ 분석 중" },
    parsing: { cls: "badge-analyzing", label: "⟳ 파싱 중" },
    filtering: { cls: "badge-analyzing", label: "⟳ 구역 확인 대기" },
    partial: { cls: "badge-partial", label: "⚡ 부분 분석" },
    error: { cls: "badge-error", label: "✕ 오류" },
  };
  const entry = map[status] ?? { cls: "badge-analyzing", label: status || "확인 필요" };
  return <span className={`badge-status ${entry.cls}`}>{entry.label}</span>;
}

export function RecentContracts({ items }: RecentContractsProps) {
  if (!items.length) {
    return (
      <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
        최근 업로드된 계약이 없습니다.
      </div>
    );
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>계약서명</th>
          <th>상태</th>
          <th>업데이트</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>
              <Link
                href={`/contracts/${item.id}`}
                style={{ color: "var(--text-primary)", textDecoration: "none" }}
              >
                <div style={{ fontWeight: 500 }}>{item.name}</div>
              </Link>
            </td>
            <td>{statusBadge(item.status)}</td>
            <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {item.updatedAt}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
