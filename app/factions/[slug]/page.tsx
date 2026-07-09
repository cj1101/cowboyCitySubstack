import { Suspense } from "react";
import FactionProfilePageClient from "./FactionProfilePageClient";

export default function FactionProfilePage() {
  return (
    <Suspense
      fallback={
        <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center">
          <p className="text-text-muted text-lg">Loading…</p>
        </div>
      }
    >
      <FactionProfilePageClient />
    </Suspense>
  );
}
