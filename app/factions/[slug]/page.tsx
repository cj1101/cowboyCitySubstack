import { Suspense } from "react";
import FactionProfilePageClient from "./FactionProfilePageClient";
import { SimCitySectionForSlug } from "@/components/city/SimCitySection";

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
      {/* The Sim sheet section (Phase 3 brief §6.1): SimSheet +
          published claims + structures/businesses summary + the city
          workbook affordance, resolved from the same slug. */}
      <SimCitySectionForSlug />
    </Suspense>
  );
}
