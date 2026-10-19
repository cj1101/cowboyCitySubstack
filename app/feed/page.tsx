import { GlobalFeed } from "@/components/posts/GlobalFeed";

/**
 * The community feed's preserved home after Phase 3 made `/` the
 * dashboard (brief §4.1, P3-D1): same component, same behavior, new
 * route. Posts also remain reachable at their /posts routes.
 */
export default function FeedPage() {
  return <GlobalFeed />;
}
