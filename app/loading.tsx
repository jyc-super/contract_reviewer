export default function Loading() {
  return (
    <div className="min-h-screen px-6 py-8">
      <div className="max-w-6xl mx-auto space-y-10">
        <div className="h-10 bg-slate-200 rounded animate-pulse max-w-md" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 h-48 bg-slate-200 rounded-xl animate-pulse" />
          <div className="h-48 bg-slate-200 rounded-xl animate-pulse" />
        </div>
        <div className="border border-slate-200 rounded-xl bg-white p-5 shadow-sm">
          <div className="h-4 bg-slate-200 rounded w-40 mb-3 animate-pulse" />
          <ul className="space-y-2">
            {[1, 2, 3].map((i) => (
              <li key={i} className="h-14 bg-slate-100 rounded-md animate-pulse" />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
