import Link from "next/link";
import { getContractList } from "../../lib/data/contracts";
import { RecentContracts } from "../../components/dashboard/RecentContracts";

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return iso.slice(0, 10);
  }
}

export default async function ContractsListPage() {
  const data = await getContractList(100);
  const contracts = data?.contracts ?? [];
  const totalContracts = data?.totalContracts ?? 0;
  const items = contracts.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status ?? "",
    updatedAt: formatDate(c.updated_at),
  }));

  return (
    <div className="min-h-screen px-6 py-8">
      <main className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              전체 계약 목록
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              총 {totalContracts}건
              {items.length < totalContracts && ` (최근 ${items.length}건 표시)` }
            </p>
          </div>
          <Link
            href="/"
            className="text-sm font-medium text-slate-700 hover:text-slate-900 underline underline-offset-2"
          >
            대시보드로 돌아가기
          </Link>
        </header>

        <section className="border border-slate-200 rounded-xl bg-white p-5 shadow-sm">
          <RecentContracts items={items} />
        </section>
      </main>
    </div>
  );
}
