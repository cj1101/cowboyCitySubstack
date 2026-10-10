"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { RealmWordmark } from "@/components/brand/RealmWordmark";
import { PersonName } from "@/components/profile/PersonName";
import { SearchBox } from "@/components/search/SearchBox";
import { FactionSwitcher } from "@/components/factions/FactionSwitcher";
import { canUseRealm, isSheriff } from "@/lib/membership";
import { getClientDb } from "@/lib/firebase";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { notificationsQuery, toNotification } from "@/lib/firestore/notifications";
import { subscribeConversations } from "@/lib/firestore/messages";
import type { AppNotification } from "@/lib/types";

const NAV_LINKS = [
  { href: "/", label: "Feed" },
  { href: "/cities", label: "Cities" },
  { href: "/maps", label: "Realm Map" },
  { href: "/treaties", label: "Treaties" },
  { href: "/forum", label: "Forum" },
  { href: "/timeline", label: "Timeline" },
  { href: "/lore-graph", label: "Lore Graph" },
  { href: "/search", label: "Search" },
] as const;

const TAB_LINKS = [
  { href: "/cities", label: "Cities" },
  { href: "/maps", label: "Map" },
  { href: "/treaties", label: "Treaties" },
  { href: "/forum", label: "Forum" },
  { href: "/messages", label: "Mail" },
] as const;

function linkActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavBar() {
  const { user, profile, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const navClass = (href: string) =>
    linkActive(pathname, href)
      ? "text-sm font-bold text-accent-gold whitespace-nowrap"
      : "text-text-muted text-sm hover:text-accent-gold whitespace-nowrap";
  const [menuOpen, setMenuOpen] = useState(false);
  const [notices, setNotices] = useState<AppNotification[]>([]);
  const [noticesReady, setNoticesReady] = useState(false);
  const [noticeError, setNoticeError] = useState("");
  const [dms, setDms] = useState(0);
  const member = !!user && canUseRealm(profile);
  const sheriff = isSheriff(profile, user?.email);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.documentElement.classList.toggle("has-tabbar", member);
    return () => document.documentElement.classList.remove("has-tabbar");
  }, [member]);

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!user || !member) {
      setNotices([]);
      setNoticesReady(false);
      setNoticeError("");
      setDms(0);
      return;
    }
    const unsubNotes = onSnapshot(
      notificationsQuery(user.uid),
      (snap) => {
        setNotices(snap.docs.map((d) => toNotification(d.id, d.data())));
        setNoticesReady(true);
        setNoticeError("");
      },
      () => {
        setNoticeError("Couldn't load notices.");
        setNoticesReady(true);
      }
    );
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
        <span className="realm-wordmark inline-flex items-center min-w-0">
          <RealmWordmark compact className="sm:hidden" />
          <RealmWordmark className="hidden sm:block" />
        </span>
        <span className="text-text-muted text-sm">Loading…</span>
      </nav>
    );
  }

  return (
    <>
      <nav className="hud">
        <Link href="/" className="realm-wordmark inline-flex items-center min-w-0" aria-label="Cowboy City home">
          <RealmWordmark compact className="sm:hidden" />
          <RealmWordmark className="hidden sm:block" />
        </Link>

        {user && member && (
          <div className="hidden md:flex items-center gap-4 min-w-0">
            {NAV_LINKS.filter((link) => link.href !== "/" && link.href !== "/search").map((link) => (
              <Link key={link.href} href={link.href} className={navClass(link.href)}>
                {link.label}
              </Link>
            ))}
            <SearchBox />
            {sheriff && (
              <Link href="/sheriff" className="text-accent-gold text-sm hover:text-accent-gold-hover font-bold whitespace-nowrap">
                Sheriff
              </Link>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 shrink-0">
          {user && member && (
            <NotificationBell
              uid={user.uid}
              items={notices}
              ready={noticesReady}
              loadError={noticeError}
              placement="header"
              closeSignal={menuOpen}
            />
          )}
          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <>
                <FactionSwitcher />
                {member && (
                  <Link href="/messages" className="text-sm text-text-muted hover:text-accent-gold min-h-11 inline-flex items-center">
                    Mail{dms > 0 ? ` (${dms})` : ""}
                  </Link>
                )}
                {(profile?.displayName || profile?.minecraftUsername) && (
                  <Link href="/settings" className="text-text-muted text-sm hidden xl:inline-flex max-w-[280px] hover:text-accent-gold">
                    <PersonName
                      uid={user.uid}
                      name={profile.displayName || "Member"}
                      email={profile.email || user.email}
                      minecraftUsername={profile.minecraftUsername}
                      avatarUrl={profile.avatarUrl}
                      isAdmin={profile.isAdmin}
                      ownsCity={profile.ownsCity}
                    />
                  </Link>
                )}
                <button type="button" onClick={handleLogout} className="btn btn-secondary text-sm px-4 py-2">
                  Sign Out
                </button>
              </>
            ) : (
              <>
                <Link href="/login" className="btn btn-secondary text-sm px-4 py-2">Sign In</Link>
                <Link href="/signup" className="btn text-sm px-4 py-2">Sign Up</Link>
              </>
            )}
          </div>
          <button
            type="button"
            className="md:hidden menu-button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
          >
            <span className="menu-glyph" aria-hidden>{menuOpen ? "×" : "☰"}</span>
          </button>
        </div>
      </nav>

      {menuOpen && (
        <div id="mobile-nav" className="mobile-nav-drawer md:hidden">
          {user && member ? (
            <div className="space-y-1">
              <SearchBox className="flex items-center gap-2 mb-3" />
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`mobile-nav-link ${linkActive(pathname, link.href) ? "text-accent-gold font-bold" : ""}`}
                  onClick={() => setMenuOpen(false)}
                >
                  {link.label}
                </Link>
              ))}
              <Link href="/messages" className="mobile-nav-link" onClick={() => setMenuOpen(false)}>
                Mail{dms > 0 ? ` (${dms})` : ""}
              </Link>
              <NotificationBell
                uid={user.uid}
                items={notices}
                ready={noticesReady}
                loadError={noticeError}
                placement="drawer"
                onNavigate={() => setMenuOpen(false)}
              />
              <Link href="/posts/new" className="mobile-nav-link" onClick={() => setMenuOpen(false)}>
                New Post
              </Link>
              <Link href="/settings" className="mobile-nav-link" onClick={() => setMenuOpen(false)}>
                <PersonName
                  uid={user.uid}
                  name={profile?.displayName || "Settings"}
                  email={profile?.email || user.email}
                  minecraftUsername={profile?.minecraftUsername}
                  avatarUrl={profile?.avatarUrl}
                  isAdmin={profile?.isAdmin}
                  ownsCity={profile?.ownsCity}
                />
              </Link>
              {sheriff && (
                <Link href="/sheriff" className="mobile-nav-link text-accent-gold font-bold" onClick={() => setMenuOpen(false)}>
                  Sheriff&apos;s Dashboard
                </Link>
              )}
              <div className="pt-4 mt-4 border-t border-primary-brown">
                <p className="text-text-muted text-xs uppercase tracking-wide mb-2">Post as</p>
                <FactionSwitcher compact />
              </div>
              <button type="button" className="btn btn-secondary w-full mt-4" onClick={handleLogout}>
                Sign Out
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <Link href="/login" className="btn btn-secondary w-full text-center" onClick={() => setMenuOpen(false)}>
                Sign In
              </Link>
              <Link href="/signup" className="btn w-full text-center" onClick={() => setMenuOpen(false)}>
                Sign Up
              </Link>
            </div>
          )}
        </div>
      )}

      {member && (
        <nav className="tabbar md:hidden" aria-label="Primary">
          {TAB_LINKS.map((link) => {
            const active = linkActive(pathname, link.href);
            const badge = link.href === "/messages" && dms > 0 ? dms : 0;
            return (
              <Link key={link.href} href={link.href} className={active ? "tabbar-link is-active" : "tabbar-link"}>
                <span>{link.label}</span>
                {badge > 0 && <span className="tabbar-badge">{badge}</span>}
              </Link>
            );
          })}
        </nav>
      )}
    </>
  );
}
