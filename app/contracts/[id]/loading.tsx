export default function ContractDetailLoading() {
  return (
    <main className="min-h-screen px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="space-y-1">
          <div className="h-8 w-3/4 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-1/2 bg-gray-100 rounded animate-pulse" />
          <div className="h-3 w-1/3 bg-gray-100 rounded animate-pulse" />
        </div>
        <section className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-6">
          <div className="space-y-3">
            <div className="h-4 w-24 bg-gray-200 rounded" />
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-16 bg-gray-100 rounded animate-pulse" />
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <div className="h-4 w-32 bg-gray-200 rounded" />
            <div className="h-32 bg-gray-100 rounded animate-pulse" />
          </div>
        </section>
      </div>
    </main>
  );
}
