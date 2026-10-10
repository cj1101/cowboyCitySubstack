import { Suspense } from "react";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { SearchScreen } from "@/components/search/SearchScreen";

export default function SearchPage() {
  return (
    <Suspense fallback={<ScreenStatus>Loading search…</ScreenStatus>}>
      <SearchScreen />
    </Suspense>
  );
}
