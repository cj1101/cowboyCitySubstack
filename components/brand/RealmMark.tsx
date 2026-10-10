/** Block mark in the light palette: ink, cyan, and yellow. */
export function RealmMark({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Cowboy City"
    >
      <rect width="16" height="16" fill="#f7f6f3" />
      <rect x="11" y="1" width="4" height="4" fill="#fed83d" />
      <rect x="12" y="2" width="2" height="2" fill="#f7f6f3" />
      <rect x="1" y="10" width="14" height="5" fill="#169c9c" />
      <rect x="1" y="10" width="14" height="1" fill="#107c7c" />
      <rect x="3" y="6" width="4" height="4" fill="#fed83d" />
      <rect x="3" y="6" width="4" height="1" fill="#1c1917" />
      <rect x="4" y="4" width="2" height="2" fill="#2f2d2a" />
      <rect x="9" y="7" width="3" height="3" fill="#2f2d2a" />
      <rect x="10" y="6" width="1" height="1" fill="#2f2d2a" />
    </svg>
  );
}
