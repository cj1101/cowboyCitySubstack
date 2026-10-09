"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { canUseRealm } from "@/lib/types";

const OPEN_PREFIXES = ["/login", "/signup", "/settings"];

export function MembershipGate({ children }: { children: ReactNode }) {
  const { user, profile, loading, claimAccess } = useAuth();
  const pathname = usePathname();

  const open = OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (loading) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <p className="text-text-muted text-lg">Loading…</p>
      </div>
    );
  }

  if (!user && !open) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
        <div className="glass-panel p-8 max-w-lg w-full text-center space-y-4">
          <h1 className="text-3xl font-bold text-accent-gold">A private chronicle</h1>
          <p className="text-text-muted">
            Request a membership. The feed, cities, messages, and maps stay closed until a sheriff approves you.
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <Link href="/signup" className="btn text-sm px-5 py-2">Request to join</Link>
            <Link href="/login" className="btn btn-secondary text-sm px-5 py-2">Sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!user || canUseRealm(profile) || open) {
    return children;
  }

  const status = profile?.status ?? "pending";
  const headline =
    status === "denied"
      ? "Request denied"
      : status === "suspended"
        ? "Membership suspended"
        : status === "removed"
          ? "Membership removed"
          : "Waiting for the Sheriff";

  const detail =
    status === "pending"
      ? "Your request to join is in. You can edit your profile while you wait. Posting, the feed, messages, and city lore stay closed until a sheriff approves you."
      : "This account cannot view members-only realm content. Ask a sheriff if you think that is a mistake.";

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="glass-panel p-8 max-w-lg w-full text-center space-y-4">
        <h1 className="text-3xl font-bold text-accent-gold">{headline}</h1>
        <p className="text-text-muted">{detail}</p>
        <p className="text-sm text-text-light">
          Signed in as <span className="text-accent-gold">{profile?.email || user.email}</span>
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          {status === "pending" && (
            <button type="button" className="btn text-sm px-5 py-2" onClick={() => claimAccess()}>
              Check approval again
            </button>
          )}
          <Link href="/settings" className="btn btn-secondary text-sm px-5 py-2">
            Edit profile
          </Link>
        </div>
      </div>
    </div>
  );
}
