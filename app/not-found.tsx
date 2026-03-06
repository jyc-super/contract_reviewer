import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen px-6 py-8 flex items-center justify-center">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-xl font-bold text-gray-900">페이지를 찾을 수 없습니다</h1>
        <p className="text-sm text-gray-600">
          요청하신 경로가 없거나 삭제되었을 수 있습니다.
        </p>
        <Link
          href="/"
          className="inline-block px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
        >
          대시보드로 돌아가기
        </Link>
      </div>
    </main>
  );
}
