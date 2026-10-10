"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useFactionContext } from "@/components/factions/FactionContext";
import { FactionForm } from "@/components/factions/FactionForm";
import { withTimeout } from "@/lib/async";
import { createFaction, isSlugTaken, updateFaction } from "@/lib/firestore/factions";
import { uploadFactionImage } from "@/lib/firestore/storage";
import type { FactionFormData } from "@/components/factions/FactionForm";
import { ScreenStatus } from "@/components/layout/ScreenStatus";

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

    if (await withTimeout(isSlugTaken(data.slug), 8000)) {
      throw new Error("That slug is already taken. Choose another.");
    }

    const faction = await withTimeout(createFaction(user.uid, {
      name: data.name,
      slug: data.slug,
      colors: data.colors,
      bio: data.bio,
      description: data.bio,
      lore: data.lore,
    }), 15000);

    let uploadNote = "";
    try {
      const [bannerUrl, sigilUrl] = await withTimeout(Promise.all([
        data.bannerFile ? uploadFactionImage(faction.id, data.bannerFile, "banner") : Promise.resolve(undefined),
        data.sigilFile ? uploadFactionImage(faction.id, data.sigilFile, "sigil") : Promise.resolve(undefined),
      ]), 20000);
      if (bannerUrl || sigilUrl) {
        await withTimeout(updateFaction(faction.id, { bannerUrl, sigilUrl }), 8000);
      }
    } catch {
      uploadNote = `?upload=failed`;
    }

    void refresh();
    router.push(`/cities/${data.slug}${uploadNote}`);
  };

  if (authLoading) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <p className="text-text-muted text-lg">Loading…</p>
      </div>
    );
  }

  if (!user) return <ScreenStatus>Sign in to found a city.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6 md:p-10">
      <div className="max-w-xl mx-auto">
        <Link href="/cities" className="text-accent-gold hover:text-accent-gold-hover text-sm mb-4 inline-block">
          ← Back to Factions
        </Link>
        <h1 className="text-3xl font-bold text-accent-gold mb-2">Found a city</h1>
        <p className="text-text-muted mb-8">Each approved person can keep one or more city accounts.</p>
        <div className="glass-panel p-8">
          <FactionForm onSubmit={handleSubmit} submitLabel="Create city" />
        </div>
      </div>
    </div>
  );
}
