"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { FactionSwitcher } from "@/components/factions/FactionSwitcher";

const NAV_LINKS = [
  { href: "/factions", label: "Factions" },
  { href: "/timeline", label: "Timeline" },
  { href: "/lore-graph", label: "Lore Graph" },
] as const;

export function NavBar() {
  const { user, profile, loading, logout } = useAuth();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout();
    router.push("/login");
  };

  if (loading) {
    return (
      <nav className="hud">
        <span className="hud-title">Cowboy City Lore</span>
        <span className="text-text-muted text-sm">Loading…</span>
      </nav>
    );
  }

  return (
    <>
      <nav className="hud">
        <div className="flex items-center gap-3 sm:gap-6 min-w-0">
          <Link
            href="/"
            className="hud-title hover:text-accent-gold-hover transition-colors truncate"
          >
            Cowboy City Lore
          </Link>
          {user && (
            <div className="hidden md:flex items-center gap-4">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-text-muted text-sm hover:text-accent-gold whitespace-nowrap"
                >
                  {link.label}
                </Link>
              ))}
              {profile?.isAdmin && (
                <Link
                  href="/sheriff"
                  className="text-accent-gold text-sm hover:text-accent-gold-hover font-bold whitespace-nowrap"
                >
                  Sheriff
                </Link>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          {user ? (
            <>
              <div className="hidden sm:block">
                <FactionSwitcher />
              </div>
              {profile?.displayName && (
                <span className="text-text-muted text-sm hidden xl:inline max-w-[120px] truncate">
                  {profile.displayName}
                </span>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="btn btn-secondary text-xs sm:text-sm px-3 sm:px-5 py-1.5 sm:py-2"
              >
                Sign Out
              </button>
              <button
                type="button"
                className="md:hidden btn btn-secondary text-sm px-3 py-1.5"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
                aria-label={menuOpen ? "Close menu" : "Open menu"}
              >
                {menuOpen ? "✕" : "☰"}
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="btn btn-secondary text-xs sm:text-sm px-3 sm:px-5 py-1.5 sm:py-2">
                Sign In
              </Link>
              <Link href="/signup" className="btn text-xs sm:text-sm px-3 sm:px-5 py-1.5 sm:py-2">
                Sign Up
              </Link>
            </>
          )}
        </div>
      </nav>

      {user && menuOpen && (
        <div className="mobile-nav-drawer md:hidden">
          <div className="space-y-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="mobile-nav-link"
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            {profile?.isAdmin && (
              <Link
                href="/sheriff"
                className="mobile-nav-link text-accent-gold font-bold"
                onClick={() => setMenuOpen(false)}
              >
                Sheriff&apos;s Dashboard
              </Link>
            )}
            <Link
              href="/posts/new"
              className="mobile-nav-link"
              onClick={() => setMenuOpen(false)}
            >
              New Post
            </Link>
          </div>
          <div className="sm:hidden pt-4 mt-4 border-t border-accent-gold/30">
            <p className="text-text-muted text-xs uppercase tracking-wide mb-2">Post as</p>
            <FactionSwitcher compact />
          </div>
        </div>
      )}
    </>
  );
}
