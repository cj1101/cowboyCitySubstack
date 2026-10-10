import { expiryBadge } from "@/lib/treaties/machine";

export function TreatyBadge({ status, expiresOn }: { status: string; expiresOn?: string }) {
  if (status !== "active" || !expiresOn) return null;
  const badge = expiryBadge(expiresOn);
  if (!badge) return null;
  const label = badge === "expiring" ? "Expiring soon" : "Expired";
  return (
    <span className="inline-block bg-accent-yellow text-on-yellow text-xs font-bold px-2 py-1 align-middle">
      {label}
    </span>
  );
}
