export const dynamic = "force-dynamic";

import Link from "next/link";
import { getContractList } from "../../lib/data/contracts";
import { RecentContracts } from "../../components/dashboard/RecentContracts";
import { AutoRefreshWrapper } from "../../components/contracts/AutoRefreshWrapper";

const PAGE_SIZE = 20;

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Seoul",
    }).format(d);
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

interface PageProps {
  searchParams: { page?: string; sort?: string; order?: string };
}

export default async function ContractsListPage({ searchParams }: PageProps) {
  // Next.js 14/15 호환: searchParams가 Promise일 수 있음
  const resolvedParams = (typeof (searchParams as Record<string, unknown>)?.then === "function")
    ? await (searchParams as unknown as Promise<{ page?: string; sort?: string; order?: string }>)
    : searchParams;

  const currentPage = Math.max(1, parseInt(resolvedParams?.page ?? "1", 10) || 1);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const sortParam = resolvedParams?.sort;
  const sort =
    sortParam === "created_at" || sortParam === "name" || sortParam === "status"
      ? sortParam
      : "updated_at";
  const ascending = resolvedParams?.order === "asc";

  const data = await getContractList({ offset, limit: PAGE_SIZE, sort, ascending });
  const contracts = data?.contracts ?? [];
  const totalContracts = data?.totalContracts ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalContracts / PAGE_SIZE));

  const items = contracts.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status ?? "",
    createdAt: formatDate(c.created_at),
    updatedAt: formatDate(c.updated_at),
    pageCount: c.page_count ?? null,
  }));

  const statuses = items.map((item) => item.status);

  return (
    <AutoRefreshWrapper statuses={statuses}>
      <div className="min-h-screen px-6 py-8">
        <main className="mx-auto max-w-6xl space-y-6">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">
                전체 계약 목록
              </h1>
              <p className="mt-1 text-sm text-text-secondary">
                총 {totalContracts}건
                {totalPages > 1 && ` (${currentPage}/${totalPages} 페이지)`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link
                href="/upload"
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-blue px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-blue/80"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                업로드
              </Link>
              <Link
                href="/"
                className="text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
              >
                대시보드
              </Link>
            </div>
          </header>

          <section className="rounded-xl border border-border-muted bg-bg-card p-5 shadow-card">
            <RecentContracts
              items={items}
              fullList
              currentPage={currentPage}
              totalPages={totalPages}
              totalContracts={totalContracts}
            />
          </section>
        </main>
      </div>
    </AutoRefreshWrapper>
  );
}
