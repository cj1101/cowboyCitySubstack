"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { isSheriff } from "@/lib/membership";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { SheriffQueue } from "@/components/sheriff/SheriffQueue";
import { PostModeration } from "@/components/sheriff/PostModeration";
import { UserManagement } from "@/components/sheriff/UserManagement";
import { FactionManagement } from "@/components/sheriff/FactionManagement";

export default function SheriffDashboardPage() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();
  const redirected = useRef(false);

  useEffect(() => {
    if (loading || redirected.current) return;
    if (!user) {
      redirected.current = true;
      router.replace("/login");
      return;
    }
    if (!profile) return;
    if (!isSheriff(profile, user.email)) {
      redirected.current = true;
      router.replace("/");
    }
  }, [user, profile, loading, router]);

  if (loading || !user) {
    return <ScreenStatus>Loading Sheriff&apos;s office…</ScreenStatus>;
  }

  if (!profile) {
    return <ScreenStatus>No membership record for this account.</ScreenStatus>;
  }

  if (!isSheriff(profile, user.email)) {
    return <ScreenStatus>Sending you back to the feed…</ScreenStatus>;
  }

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 sm:p-6 md:p-10">
      <div className="max-w-5xl mx-auto space-y-10">
        <header>
          <Link href="/" className="text-accent-gold hover:text-accent-gold-hover text-sm">
            ← Back to Feed
          </Link>
          <h1 className="text-3xl font-bold text-accent-gold mt-2">
            Sheriff&apos;s Dashboard
          </h1>
          <p className="text-text-muted mt-1">
            Suspend or remove members. Root sheriffs are the two emails listed in firestore.rules.
          </p>
          {!profile.isAdmin && (
            <p className="text-sm text-text-muted mt-3">
              This email is a root sheriff, but Firestore has not stored the admin flag yet. Suspend and remove will fail until the new rules are deployed.
            </p>
          )}
        </header>

        <section className="glass-panel p-6 md:p-8">
          <h2 className="text-xl font-bold text-accent-gold mb-4">
            HTML Approval Queue
          </h2>
          <p className="text-text-muted text-sm mb-6">
            Faction owners submit custom HTML for their profile pages. Review before it goes live.
          </p>
          <SheriffQueue />
        </section>

        <section className="glass-panel p-6 md:p-8">
          <h2 className="text-xl font-bold text-accent-gold mb-4">Post Moderation</h2>
          <p className="text-text-muted text-sm mb-6">
            Delete any post in the realm. Recent posts shown first (up to 50).
          </p>
          <PostModeration />
        </section>

        <section className="glass-panel p-6 md:p-8">
          <h2 className="text-xl font-bold text-accent-gold mb-4">User Management</h2>
          <p className="text-text-muted text-sm mb-6">
            Suspend or remove people. Root sheriff emails are hardcoded in firestore.rules and storage.rules.
          </p>
          <UserManagement currentUid={user.uid} />
        </section>

        <section className="glass-panel p-6 md:p-8">
          <h2 className="text-xl font-bold text-accent-gold mb-4">Faction Management</h2>
          <p className="text-text-muted text-sm mb-6">
            View and delete factions. Deleting a faction removes owner memberships but not posts.
          </p>
          <FactionManagement />
        </section>
      </div>
    </div>
  );
}
