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
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { getClientAuth, getClientDb } from "@/lib/firebase";
import type { MembershipStatus } from "@/lib/types";

export interface UserProfile {
  email: string;
  displayName: string;
  isAdmin: boolean;
  status: MembershipStatus;
  bio?: string;
  avatarUrl?: string;
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
    createdAt: data.createdAt,
  };
}

async function claimMembership(uid: string, email: string): Promise<void> {
  const db = getClientDb();
  const userRef = doc(db, "users", uid);
  try {
    await updateDoc(userRef, { isAdmin: true, status: "approved" });
    return;
  } catch {
    // Not on the rules allowlist. Fall through to invites.
  }

  const inviteId = email.trim().toLowerCase();
  const inviteRef = doc(db, "invites", inviteId);
  const inviteSnap = await getDoc(inviteRef);
  if (!inviteSnap.exists()) return;
  const inviteStatus = inviteSnap.data().status;
  if (inviteStatus === "revoked" || inviteStatus === "accepted") return;

  await updateDoc(userRef, { status: "approved" });
  await updateDoc(inviteRef, { status: "accepted", acceptedUid: uid });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = getClientAuth();
    let unsubProfile: (() => void) | undefined;

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      unsubProfile?.();
      setUser(firebaseUser);

      if (!firebaseUser) {
        setProfile(null);
        setLoading(false);
        return;
      }

      const db = getClientDb();
      unsubProfile = onSnapshot(
        doc(db, "users", firebaseUser.uid),
        (snap) => {
          setProfile(snap.exists() ? toProfile(snap.data()) : null);
          setLoading(false);
        },
        () => {
          setProfile(null);
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
    if (!user || !profile || profile.status !== "pending") return;
    claimMembership(user.uid, profile.email || user.email || "").catch(() => {
      // Still pending, denied, or suspended.
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
      status: "pending",
      createdAt: serverTimestamp(),
    });
  }, []);

  const logout = useCallback(async () => {
    await signOut(getClientAuth());
    setProfile(null);
  }, []);

  const claimAccess = useCallback(async () => {
    if (!user) return;
    await claimMembership(user.uid, profile?.email || user.email || "");
  }, [user, profile?.email]);

  const refreshProfile = useCallback(async () => {
    if (!user) return;
    const snap = await getDoc(doc(getClientDb(), "users", user.uid));
    setProfile(snap.exists() ? toProfile(snap.data()) : null);
  }, [user]);

  const value = useMemo(
    () => ({ user, profile, loading, signIn, signUp, logout, claimAccess, refreshProfile }),
    [user, profile, loading, signIn, signUp, logout, claimAccess, refreshProfile]
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
