"use client";

import { useFactionContext } from "@/components/factions/FactionContext";

interface FactionSwitcherProps {
  compact?: boolean;
}

export function FactionSwitcher({ compact = false }: FactionSwitcherProps) {
  const {
    userFactions,
    characters,
    selectedFaction,
    selectedCharacter,
    loading,
    setSelectedFactionId,
    setSelectedCharacterId,
  } = useFactionContext();

  if (loading) {
    return (
      <span className="text-text-muted text-sm">
        {compact ? "…" : "Loading factions…"}
      </span>
    );
  }

  if (userFactions.length === 0) {
    return null;
  }

  const selectClass = compact
    ? "form-input text-sm py-1.5 px-2 w-full"
    : "form-input text-sm py-1.5 px-2 w-auto max-w-[140px]";

  const wrapperClass = compact
    ? "flex flex-col gap-2"
    : "flex items-center gap-2 flex-wrap";

  return (
    <div className={wrapperClass}>
      {!compact && (
        <label className="text-text-muted text-xs uppercase tracking-wide whitespace-nowrap">
          Post as
        </label>
      )}
      <select
        value={selectedFaction?.id ?? ""}
        onChange={(e) => setSelectedFactionId(e.target.value)}
        className={selectClass}
        aria-label="Select faction"
      >
        {userFactions.map((faction) => (
          <option key={faction.id} value={faction.id}>
            {faction.name}
          </option>
        ))}
      </select>
      {characters.length > 0 && (
        <select
          value={selectedCharacter?.id ?? ""}
          onChange={(e) => setSelectedCharacterId(e.target.value)}
          className={selectClass}
          aria-label="Select character"
        >
          {characters.map((character) => (
            <option key={character.id} value={character.id}>
              {character.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
