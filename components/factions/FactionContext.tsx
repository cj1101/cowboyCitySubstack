"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { getFactionsForUser } from "@/lib/firestore/factions";
import { getActiveCharactersForFaction } from "@/lib/firestore/characters";
import type { Character, Faction, PostingIdentity } from "@/lib/types";

const STORAGE_KEY = "cowboy-city-posting-identity";

interface FactionContextValue {
  userFactions: Faction[];
  characters: Character[];
  selectedFaction: Faction | null;
  selectedCharacter: Character | null;
  postingIdentity: PostingIdentity | null;
  loading: boolean;
  setSelectedFactionId: (factionId: string) => void;
  setSelectedCharacterId: (characterId: string) => void;
  refresh: () => Promise<void>;
}

const FactionContext = createContext<FactionContextValue | null>(null);

function loadStoredIds(): { factionId: string | null; characterId: string | null } {
  if (typeof window === "undefined") return { factionId: null, characterId: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { factionId: null, characterId: null };
    const parsed = JSON.parse(raw) as { factionId?: string; characterId?: string };
    return { factionId: parsed.factionId ?? null, characterId: parsed.characterId ?? null };
  } catch {
    return { factionId: null, characterId: null };
  }
}

function saveStoredIds(factionId: string | null, characterId: string | null) {
  if (typeof window === "undefined") return;
  if (!factionId) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ factionId, characterId }));
}

export function FactionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [userFactions, setUserFactions] = useState<Faction[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedFactionId, setSelectedFactionIdState] = useState<string | null>(null);
  const [selectedCharacterId, setSelectedCharacterIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!user) {
      setUserFactions([]);
      setCharacters([]);
      setSelectedFactionIdState(null);
      setSelectedCharacterIdState(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const factions = await getFactionsForUser(user.uid);
      setUserFactions(factions);

      const stored = loadStoredIds();
      let factionId = stored.factionId;
      let characterId = stored.characterId;

      if (!factionId || !factions.some((f) => f.id === factionId)) {
        factionId = factions[0]?.id ?? null;
        characterId = null;
      }

      if (factionId) {
        const chars = await getActiveCharactersForFaction(factionId);
        setCharacters(chars);
        if (!characterId || !chars.some((c) => c.id === characterId)) {
          characterId = chars[0]?.id ?? null;
        }
      } else {
        setCharacters([]);
        characterId = null;
      }

      setSelectedFactionIdState(factionId);
      setSelectedCharacterIdState(characterId);
      saveStoredIds(factionId, characterId);
    } catch {
      setUserFactions([]);
      setCharacters([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const setSelectedFactionId = useCallback(
    async (factionId: string) => {
      setSelectedFactionIdState(factionId);
      try {
        const chars = await getActiveCharactersForFaction(factionId);
        setCharacters(chars);
        const characterId = chars[0]?.id ?? null;
        setSelectedCharacterIdState(characterId);
        saveStoredIds(factionId, characterId);
      } catch {
        setCharacters([]);
        setSelectedCharacterIdState(null);
        saveStoredIds(factionId, null);
      }
    },
    []
  );

  const setSelectedCharacterId = useCallback((characterId: string) => {
    setSelectedCharacterIdState(characterId);
    setSelectedFactionIdState((currentFactionId) => {
      saveStoredIds(currentFactionId, characterId);
      return currentFactionId;
    });
  }, []);

  const selectedFaction = useMemo(
    () => userFactions.find((f) => f.id === selectedFactionId) ?? null,
    [userFactions, selectedFactionId]
  );

  const selectedCharacter = useMemo(
    () => characters.find((c) => c.id === selectedCharacterId) ?? null,
    [characters, selectedCharacterId]
  );

  const postingIdentity = useMemo((): PostingIdentity | null => {
    if (!selectedFaction || !selectedCharacter) return null;
    return {
      factionId: selectedFaction.id,
      factionName: selectedFaction.name,
      factionSlug: selectedFaction.slug,
      factionColors: selectedFaction.colors,
      characterId: selectedCharacter.id,
      characterName: selectedCharacter.name,
    };
  }, [selectedFaction, selectedCharacter]);

  const value = useMemo(
    () => ({
      userFactions,
      characters,
      selectedFaction,
      selectedCharacter,
      postingIdentity,
      loading,
      setSelectedFactionId,
      setSelectedCharacterId,
      refresh: loadData,
    }),
    [
      userFactions,
      characters,
      selectedFaction,
      selectedCharacter,
      postingIdentity,
      loading,
      setSelectedFactionId,
      setSelectedCharacterId,
      loadData,
    ]
  );

  return <FactionContext.Provider value={value}>{children}</FactionContext.Provider>;
}

export function useFactionContext(): FactionContextValue {
  const context = useContext(FactionContext);
  if (!context) {
    throw new Error("useFactionContext must be used within a FactionProvider");
  }
  return context;
}
