/**
 * Pixel wordmark: a block emblem (hat, star, cyan ground) beside beveled
 * yellow letters. The compact mark is the emblem alone, for the short mobile bar.
 */

const GLYPHS: Record<string, string[]> = {
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  W: ["10001", "10001", "10001", "10101", "10101", "01010", "01010"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

const CELL = 3;
const GAP = 2;

function Word({
  text,
  x,
  y,
}: {
  text: string;
  x: number;
  y: number;
}) {
  const rects: { x: number; y: number; fill: string; depth?: boolean }[] = [];
  let cursor = x;
  for (const char of text) {
    const rows = GLYPHS[char];
    if (!rows) continue;
    rows.forEach((row, rowIndex) => {
      [...row].forEach((bit, colIndex) => {
        if (bit !== "1") return;
        const px = cursor + colIndex * CELL;
        const py = y + rowIndex * CELL;
        rects.push({ x: px + 2, y: py + 2, fill: "#0c6868", depth: true });
        rects.push({ x: px, y: py, fill: "#fed83d" });
        rects.push({ x: px, y: py, fill: "#fff3a3" });
      });
    });
    cursor += 5 * CELL + GAP;
  }
  return (
    <g>
      {rects.filter((rect) => rect.depth).map((rect, index) => (
        <rect key={`d-${index}`} className="wordmark-depth" x={rect.x} y={rect.y} width={CELL} height={CELL} fill={rect.fill} />
      ))}
      {rects.filter((rect) => !rect.depth && rect.fill === "#fed83d").map((rect, index) => (
        <rect key={`f-${index}`} x={rect.x} y={rect.y} width={CELL} height={CELL} fill={rect.fill} />
      ))}
      {rects.filter((rect) => rect.fill === "#fff3a3").map((rect, index) => (
        <rect key={`h-${index}`} x={rect.x} y={rect.y} width={CELL} height={1} fill={rect.fill} />
      ))}
    </g>
  );
}

function Emblem() {
  return (
    <g>
      <rect x="1" y="1" width="46" height="46" fill="#f7f6f3" stroke="#2f2d2a" strokeWidth="2" />
      <rect x="3" y="34" width="42" height="11" fill="#169c9c" />
      <rect x="3" y="34" width="42" height="2" fill="#107c7c" />
      <rect x="8" y="22" width="14" height="12" fill="#fed83d" />
      <rect x="8" y="22" width="14" height="2" fill="#1c1917" />
      <rect x="12" y="26" width="4" height="4" fill="#2f2d2a" />
      <rect x="10" y="16" width="4" height="6" fill="#2f2d2a" />
      <rect x="14" y="8" width="16" height="4" fill="#2f2d2a" />
      <rect x="12" y="12" width="20" height="4" fill="#2f2d2a" />
      <rect x="8" y="16" width="28" height="3" fill="#1c1917" />
      <rect className="wordmark-brim" x="8" y="16" width="28" height="1" fill="#fed83d" />
      <g className="wordmark-star">
        <rect x="32" y="22" width="8" height="8" fill="#fed83d" />
        <rect x="34" y="20" width="4" height="12" fill="#fed83d" />
        <rect x="30" y="24" width="12" height="4" fill="#fed83d" />
        <rect x="34" y="24" width="4" height="4" fill="#fff3a3" />
      </g>
    </g>
  );
}

export function RealmWordmark({
  compact = false,
  className = "",
}: {
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <svg
        viewBox="0 0 48 48"
        className={`h-9 w-9 ${className}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label="Cowboy City"
      >
        <Emblem />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 162 54"
      className={`h-11 w-auto ${className}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Cowboy City"
    >
      <Emblem />
      <Word text="COWBOY" x={54} y={2} />
      <Word text="CITY" x={54} y={28} />
    </svg>
  );
}
