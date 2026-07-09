import type { Stance } from "@/lib/types";

const STANCE_CONFIG: Record<
  Stance,
  { label: string; className: string }
> = {
  for: {
    label: "For",
    className: "bg-green-900/60 text-green-200 border-green-600",
  },
  against: {
    label: "Against",
    className: "bg-red-900/60 text-red-200 border-red-600",
  },
  neutral: {
    label: "Neutral",
    className: "bg-primary-brown/80 text-text-muted border-accent-gold/50",
  },
};

interface StanceTagProps {
  stance: Stance;
  size?: "sm" | "md";
}

export function StanceTag({ stance, size = "md" }: StanceTagProps) {
  const config = STANCE_CONFIG[stance];
  const sizeClass = size === "sm" ? "text-xs px-2 py-0.5" : "text-sm px-3 py-1";

  return (
    <span
      className={`inline-block rounded-full border font-bold uppercase tracking-wide ${config.className} ${sizeClass}`}
    >
      {config.label}
    </span>
  );
}

export const STANCE_OPTIONS: { value: Stance; label: string }[] = [
  { value: "for", label: "For" },
  { value: "against", label: "Against" },
  { value: "neutral", label: "Neutral" },
];
