import Link from "next/link";

export default function ThreadNotFound() {
  return (
    <main className="mx-auto max-w-xl px-5 py-20 text-center">
      <h1 className="text-2xl font-semibold">Thread not found</h1>
      <p className="mt-2 text-muted">It may have been removed, or it belongs to a workspace you are not in.</p>
      <Link href="/" className="btn-primary mt-6">Back to threads</Link>
    </main>
  );
}
