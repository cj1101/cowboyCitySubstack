"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase";
import {
  isBlockedStatus,
  isRootSheriffEmail,
  REQUIRE_APPROVAL,
} from "@/lib/membership";
import type { MembershipStatus } from "@/lib/types";

export interface UserProfile {
  email: string;
  displayName: string;
  isAdmin: boolean;
  status: MembershipStatus;
  bio?: string;
  avatarUrl?: string;
  minecraftName?: string;
  ownsCity?: boolean;
  createdAt?: unknown;
}

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  claimAccess: () => Promise<void>;
  claimFailed: boolean;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toProfile(data: Record<string, unknown>): UserProfile {
  const status = (data.status as MembershipStatus) || "pending";
  return {
    email: (data.email as string) || "",
    displayName: (data.displayName as string) || "",
    isAdmin: data.isAdmin === true,
    status,
    bio: (data.bio as string) || "",
    avatarUrl: (data.avatarUrl as string) || "",
    minecraftName: (data.minecraftName as string) || "",
    ownsCity: data.ownsCity === true,
    createdAt: data.createdAt,
  };
}

function sameProfile(current: UserProfile | null, next: UserProfile | null): boolean {
  if (!current || !next) return current === next;
  return current.email === next.email &&
    current.displayName === next.displayName &&
    current.isAdmin === next.isAdmin &&
    current.status === next.status &&
    current.bio === next.bio &&
    current.avatarUrl === next.avatarUrl &&
    current.minecraftName === next.minecraftName &&
    current.ownsCity === next.ownsCity;
}

async function settleMembership(uid: string, email: string, profile: UserProfile): Promise<boolean> {
  const userRef = doc(getClientDb(), "users", uid);
  const root = isRootSheriffEmail(email);

  if (root && (!profile.isAdmin || isBlockedStatus(profile.status))) {
    try {
      await updateDoc(userRef, { isAdmin: true, status: "approved" });
      return true;
    } catch {
      // The July rules reject any write that changes isAdmin. Do not retry.
    }
  }

  if (profile.status === "pending") {
    try {
      await updateDoc(userRef, { status: "approved" });
      if (!REQUIRE_APPROVAL) return true;
    } catch {
      if (!REQUIRE_APPROVAL) return false;
    }
  }

  if (!REQUIRE_APPROVAL) return !isBlockedStatus(profile.status);

  try {
    const inviteRef = doc(getClientDb(), "invites", email.trim().toLowerCase());
    const inviteSnap = await getDoc(inviteRef);
    if (!inviteSnap.exists()) return false;
    const inviteStatus = inviteSnap.data().status;
    if (inviteStatus === "revoked" || inviteStatus === "accepted") return false;
    await updateDoc(userRef, { status: "approved" });
    await updateDoc(inviteRef, { status: "accepted", acceptedUid: uid });
    return true;
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [claimFailed, setClaimFailed] = useState(false);
  const settled = useRef(new Set<string>());

  useEffect(() => {
    const auth = getClientAuth();
    let unsubProfile: (() => void) | undefined;
    let subscribedUid: string | null = null;

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (!firebaseUser) {
        subscribedUid = null;
        unsubProfile?.();
        unsubProfile = undefined;
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      setUser((current) => (current?.uid === firebaseUser.uid ? current : firebaseUser));
      if (subscribedUid === firebaseUser.uid && unsubProfile) {
        setLoading(false);
        return;
      }

      unsubProfile?.();
      subscribedUid = firebaseUser.uid;
      unsubProfile = onSnapshot(
        doc(getClientDb(), "users", firebaseUser.uid),
        (snap) => {
          const next = snap.exists() ? toProfile(snap.data()) : null;
          setProfile((current) => (sameProfile(current, next) ? current : next));
          setLoading(false);
        },
        () => {
          setLoading(false);
        }
      );
    });

    return () => {
      unsubProfile?.();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user || !profile) return;
    if (settled.current.has(user.uid)) return;
    const email = profile.email || user.email || "";
    const root = isRootSheriffEmail(email);
    const needsStatus = profile.status === "pending";
    const needsAdmin = root && !profile.isAdmin;
    const needsRestore = root && isBlockedStatus(profile.status);
    if (!needsStatus && !needsAdmin && !needsRestore) return;
    settled.current.add(user.uid);
    settleMembership(user.uid, email, profile).then((ok) => {
      if (!ok && REQUIRE_APPROVAL) setClaimFailed(true);
    }).catch(() => {
      if (REQUIRE_APPROVAL) setClaimFailed(true);
    });
  }, [user, profile]);

  const signIn = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(getClientAuth(), email, password);
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName: string) => {
    const credential = await createUserWithEmailAndPassword(getClientAuth(), email, password);
    await setDoc(doc(getClientDb(), "users", credential.user.uid), {
      email: email.trim(),
      displayName: displayName.trim(),
      bio: "",
      avatarUrl: "",
      isAdmin: false,
      status: REQUIRE_APPROVAL ? "pending" : "approved",
      createdAt: serverTimestamp(),
    });
  }, []);

  const logout = useCallback(async () => {
    await signOut(getClientAuth());
    setProfile(null);
  }, []);

  const claimAccess = useCallback(async () => {
    if (!user || !profile) return;
    settled.current.delete(user.uid);
    setClaimFailed(false);
    const ok = await settleMembership(user.uid, profile.email || user.email || "", profile);
    settled.current.add(user.uid);
    if (!ok && REQUIRE_APPROVAL) setClaimFailed(true);
  }, [user, profile]);

  const refreshProfile = useCallback(async () => {
    if (!user) return;
    const snap = await getDoc(doc(getClientDb(), "users", user.uid));
    setProfile(snap.exists() ? toProfile(snap.data()) : null);
  }, [user]);

  const value = useMemo(
    () => ({ user, profile, loading, signIn, signUp, logout, claimAccess, claimFailed, refreshProfile }),
    [user, profile, loading, signIn, signUp, logout, claimAccess, claimFailed, refreshProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
