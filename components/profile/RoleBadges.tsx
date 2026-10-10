import { ROLE_LABELS, type RealmRole } from "@/lib/profile/identity";

const TONE: Record<RealmRole, string> = {
  sheriff: "bg-accent-yellow text-on-yellow",
  founder: "bg-accent-cyan text-white",
  admin: "bg-ink text-white",
};

export function RoleBadges({ roles }: { roles: RealmRole[] }) {
  if (roles.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {roles.map((role) => (
        <span key={role} className={`inline-block px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide border border-ink ${TONE[role]}`}>
          {ROLE_LABELS[role]}
        </span>
      ))}
    </span>
  );
}
