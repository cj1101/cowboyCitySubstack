"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useFactionContext } from "@/components/factions/FactionContext";
import { FactionForm } from "@/components/factions/FactionForm";
import { createFaction, isSlugTaken } from "@/lib/firestore/factions";
import { uploadFactionImage } from "@/lib/firestore/storage";
import type { FactionFormData } from "@/components/factions/FactionForm";

export default function NewFactionPage() {
  const { user, loading: authLoading } = useAuth();
  const { refresh } = useFactionContext();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/login");
    }
  }, [user, authLoading, router]);

  const handleSubmit = async (data: FactionFormData) => {
    if (!user) throw new Error("You must be signed in");

    if (await isSlugTaken(data.slug)) {
      throw new Error("That slug is already taken. Choose another.");
    }

    const faction = await createFaction(user.uid, {
      name: data.name,
      slug: data.slug,
      colors: data.colors,
      bio: data.bio,
    });

    let bannerUrl: string | undefined;
    let sigilUrl: string | undefined;

    if (data.bannerFile) {
      bannerUrl = await uploadFactionImage(faction.id, data.bannerFile, "banner");
    }
    if (data.sigilFile) {
      sigilUrl = await uploadFactionImage(faction.id, data.sigilFile, "sigil");
    }

    if (bannerUrl || sigilUrl) {
      const { updateFaction } = await import("@/lib/firestore/factions");
      await updateFaction(faction.id, { bannerUrl, sigilUrl });
    }

    await refresh();
    router.push(`/factions/${data.slug}/edit`);
  };

  if (authLoading) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <p className="text-text-muted text-lg">Loading…</p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6 md:p-10">
      <div className="max-w-xl mx-auto">
        <Link href="/factions" className="text-accent-gold hover:text-accent-gold-hover text-sm mb-4 inline-block">
          ← Back to Factions
        </Link>
        <h1 className="text-3xl font-bold text-accent-gold mb-2">Found a Faction</h1>
        <p className="text-text-muted mb-8">Establish your city, guild, or power in the realm.</p>
        <div className="glass-panel p-8">
          <FactionForm onSubmit={handleSubmit} submitLabel="Create Faction" />
        </div>
      </div>
    </div>
  );
}
