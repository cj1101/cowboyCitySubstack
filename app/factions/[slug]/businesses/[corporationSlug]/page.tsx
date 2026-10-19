import { Suspense } from "react";
import { EntityRouteClient } from "@/components/entity/EntityRouteClient";

/**
 * Business entity page (Phase 3 brief §8.1 — ADDITIVE route).
 * Resolution (sim record → pin/wiki presentation), the six-section
 * template, slug-rename redirects, the business-scoped §7.2 claims
 * block, and the §10.4 workbook live in the shared route host.
 */
export default function BusinessEntityPage() {
  return (
    <Suspense
      fallback={
        <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center">
          <p className="text-text-muted text-lg">Loading…</p>
        </div>
      }
    >
      <EntityRouteClient kind="business" />
    </Suspense>
  );
}
