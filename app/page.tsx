import DashboardHome from "./DashboardHome";

/**
 * Home is the dashboard (Phase 3 brief §4.1; flag P3-D1 — Koda confirms
 * or flips at integration; if flipped, this file renders GlobalFeed
 * again and DashboardHome moves to app/dashboard/ unchanged).
 * The social feed remains fully reachable at /feed and its posts routes.
 */
export default function HomePage() {
  return <DashboardHome />;
}
