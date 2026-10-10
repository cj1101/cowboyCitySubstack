"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { canUseRealm, isBlockedStatus, REQUIRE_APPROVAL } from "@/lib/membership";

const OPEN_PREFIXES = ["/login", "/signup", "/settings"];

export function MembershipGate({ children }: { children: ReactNode }) {
  const { user, profile, loading, claimAccess, claimFailed } = useAuth();
  const pathname = usePathname();
  const open = OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (loading && !user) {
    return <ScreenStatus>Loading…</ScreenStatus>;
  }

  if (!user && !open) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
        <div className="glass-panel p-8 max-w-lg w-full text-center space-y-4">
          <h1 className="text-3xl font-bold text-accent-gold">A private chronicle</h1>
          <p className="text-text-muted">
            Create an account to read the feed, found a city, and write to the realm.
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <Link href="/signup" className="btn text-sm px-5 py-2">Create an account</Link>
            <Link href="/login" className="btn btn-secondary text-sm px-5 py-2">Sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!user || open) return children;

  if (profile && isBlockedStatus(profile.status)) {
    const removed = profile.status === "removed";
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
        <div className="glass-panel p-8 max-w-lg w-full text-center space-y-4">
          <h1 className="text-3xl font-bold text-accent-gold">
            {removed ? "Membership removed" : "Membership suspended"}
          </h1>
          <p className="text-text-muted">
            This account cannot view the realm. Ask a sheriff if you think that is a mistake.
          </p>
          <p className="text-sm text-text-light">
            Signed in as <span className="text-accent-gold">{profile.email || user.email}</span>
          </p>
          <Link href="/settings" className="btn btn-secondary text-sm px-5 py-2">Edit profile</Link>
        </div>
      </div>
    );
  }

  if (REQUIRE_APPROVAL && !canUseRealm(profile)) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
        <div className="glass-panel p-8 max-w-lg w-full text-center space-y-4">
          <h1 className="text-3xl font-bold text-accent-gold">
            {claimFailed ? "Could not open your membership" : "Membership is not open"}
          </h1>
          <p className="text-text-muted">
            {claimFailed
              ? "Firestore refused the membership update. Nothing is retrying on its own. You can try once more."
              : "This account is signed in, but it cannot use the realm yet."}
          </p>
          <p className="text-sm text-text-light">
            Signed in as <span className="text-accent-gold">{profile?.email || user.email}</span>
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            {claimFailed && (
              <button type="button" className="btn text-sm px-5 py-2" onClick={() => claimAccess()}>
                Try again
              </button>
            )}
            <Link href="/settings" className="btn btn-secondary text-sm px-5 py-2">Edit profile</Link>
          </div>
        </div>
      </div>
    );
  }

  return children;
}
