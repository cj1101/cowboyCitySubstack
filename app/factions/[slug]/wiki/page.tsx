import { Suspense } from "react";
import FactionWikiPageClient from "./FactionWikiPageClient";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="wood-texture min-h-[calc(100vh-4rem)] p-8">
          <div className="max-w-4xl mx-auto glass-panel p-8 text-center text-text-muted">
            Loading wiki…
          </div>
        </div>
      }
    >
      <FactionWikiPageClient />
    </Suspense>
  );
}
