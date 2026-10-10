import Link from "next/link";
import type { Faction } from "@/lib/types";

interface FactionCardProps {
  faction: Faction;
}

export function FactionCard({ faction }: FactionCardProps) {
  const { primary, secondary } = faction.colors;

  return (
    <Link
      href={`/cities/${faction.slug}`}
      className="glass-panel overflow-hidden block transition-transform hover:-translate-y-1"
    >
      <div
        className="h-24 relative"
        style={{
          background: faction.bannerUrl
            ? `url(${faction.bannerUrl}) center/cover`
            : `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`,
        }}
      >
        {faction.sigilUrl && (
          <img
            src={faction.sigilUrl}
            alt={`${faction.name} sigil`}
            className="absolute bottom-0 left-4 translate-y-1/2 w-16 h-16 rounded-full border-2 border-accent-gold object-cover bg-darker-brown"
          />
        )}
      </div>
      <div className={`p-5 ${faction.sigilUrl ? "pt-10" : "pt-4"}`}>
        <h2 className="text-xl font-bold text-accent-gold">{faction.name}</h2>
        {faction.motto && <p className="text-sm italic mt-2">{faction.motto}</p>}
        {faction.population != null && (
          <p className="text-xs text-text-muted mt-1">Population {faction.population.toLocaleString()}</p>
        )}
        {faction.bio && (
          <p className="text-text-muted text-sm mt-2 line-clamp-2">{faction.bio}</p>
        )}
      </div>
    </Link>
  );
}
