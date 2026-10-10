"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { RealmMark } from "@/components/brand/RealmMark";
import { FactionSwitcher } from "@/components/factions/FactionSwitcher";
import { canUseRealm, isSheriff } from "@/lib/membership";
import { getClientDb } from "@/lib/firebase";
import { notificationsQuery, toNotification } from "@/lib/firestore/notifications";
import { subscribeConversations } from "@/lib/firestore/messages";

const NAV_LINKS = [
  { href: "/cities", label: "Cities" },
  { href: "/maps", label: "Realm Map" },
  { href: "/treaties", label: "Treaties" },
  { href: "/forum", label: "Forum" },
  { href: "/timeline", label: "Timeline" },
  { href: "/lore-graph", label: "Lore Graph" },
  { href: "/search", label: "Search" },
] as const;

export function NavBar() {
  const { user, profile, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const navClass = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`)
      ? "text-sm font-bold text-accent-gold whitespace-nowrap"
      : "text-text-muted text-sm hover:text-accent-gold whitespace-nowrap";
  const [menuOpen, setMenuOpen] = useState(false);
  const [notes, setNotes] = useState(0);
  const [dms, setDms] = useState(0);
  const member = !!user && canUseRealm(profile);
  const sheriff = isSheriff(profile, user?.email);

  useEffect(() => {
    if (!user || !member) return;
    const unsubNotes = onSnapshot(notificationsQuery(user.uid), (snap) => {
      setNotes(snap.docs.map((d) => toNotification(d.id, d.data())).filter((item) => !item.read).length);
    });
    let reads: Record<string, number> = {};
    const unsubReads = onSnapshot(collection(getClientDb(), "users", user.uid, "reads"), (snap) => {
      reads = {};
      snap.docs.forEach((d) => {
        reads[d.id] = d.data().lastReadAt?.toMillis?.() ?? 0;
      });
    });
    const unsubDms = subscribeConversations(user.uid, (conversations) => {
      setDms(
        conversations.filter((conversation) => {
          const at = conversation.lastMessageAt?.toMillis?.() ?? 0;
          return at > (reads[conversation.id] ?? 0) && conversation.lastSenderUid !== user.uid;
        }).length
      );
    });
    return () => {
      unsubNotes();
      unsubReads();
      unsubDms();
    };
  }, [user, member]);

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout();
    router.push("/login");
  };

  if (loading) {
    return (
      <nav className="hud">
        <span className="inline-flex items-center gap-2">
          <RealmMark className="w-8 h-8 border-2 border-ink" />
          <span className="hud-title">Cowboy City</span>
        </span>
        <span className="text-text-muted text-sm">Loading…</span>
      </nav>
    );
  }

  return (
    <>
      <nav className="hud">
        <div className="flex items-center gap-3 sm:gap-6 min-w-0">
          <Link href="/" className="inline-flex items-center gap-2 min-w-0 hover:opacity-80">
            <RealmMark className="w-8 h-8 shrink-0 border-2 border-ink" />
            <span className="hud-title truncate">Cowboy City</span>
          </Link>
          {user && member && (
            <div className="hidden md:flex items-center gap-4">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={navClass(link.href)}
                >
                  {link.label}
                </Link>
              ))}
              {sheriff && (
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
              {member && (
                <>
                  <Link href="/messages" className="text-sm text-text-muted hover:text-accent-gold">
                    Mail{dms > 0 ? ` (${dms})` : ""}
                  </Link>
                  <Link href="/notifications" className="text-sm text-text-muted hover:text-accent-gold">
                    Notices{notes > 0 ? ` (${notes})` : ""}
                  </Link>
                </>
              )}
              {profile?.displayName && (
                <Link href="/settings" className="text-text-muted text-sm hidden xl:inline max-w-[120px] truncate hover:text-accent-gold">
                  {profile.displayName}
                </Link>
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

      {user && member && menuOpen && (
        <div className="mobile-nav-drawer md:hidden">
          <div className="space-y-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`mobile-nav-link ${pathname === link.href || pathname.startsWith(`${link.href}/`) ? "text-accent-gold font-bold" : ""}`}
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            {sheriff && (
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
          <div className="sm:hidden pt-4 mt-4 border-t border-primary-brown">
            <p className="text-text-muted text-xs uppercase tracking-wide mb-2">Post as</p>
            <FactionSwitcher compact />
          </div>
        </div>
      )}
    </>
  );
}
