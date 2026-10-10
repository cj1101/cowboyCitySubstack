"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { RealmMark } from "@/components/brand/RealmMark";

export default function SignupPage() {
  const { user, loading, signUp } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const redirected = useRef(false);

  useEffect(() => {
    if (loading || !user || redirected.current) return;
    redirected.current = true;
    router.replace("/");
  }, [user, loading, router]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setSubmitting(true);
    try {
      await signUp(email, password, displayName);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <p className="text-text-muted text-lg">Loading…</p>
      </div>
    );
  }

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center p-4 sm:p-8">
      <div className="glass-panel p-6 sm:p-10 max-w-md w-full">
        <div className="flex flex-col items-center gap-3 mb-4">
          <RealmMark className="w-16 h-16 border-4 border-ink" />
          <p className="pixel-title text-center">Cowboy City & The Realm</p>
        </div>
        <h1 className="text-3xl font-bold text-ink text-center mb-2">
          Join the Realm
        </h1>
        <p className="text-text-muted text-center mb-8">
          Create an account and sign in. You can read the chronicle and post right away.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="displayName" className="form-label">
              Display Name
            </label>
            <input
              id="displayName"
              type="text"
              required
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="form-input"
              placeholder="Your real name (private)"
            />
          </div>
          <div>
            <label htmlFor="email" className="form-label">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="form-input"
            />
          </div>
          <div>
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="form-input"
            />
          </div>
          <div>
            <label htmlFor="confirmPassword" className="form-label">
              Confirm Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="form-input"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm text-center">{error}</p>
          )}

          <button type="submit" disabled={submitting} className="btn w-full">
            {submitting ? "Creating account…" : "Create Account"}
          </button>
        </form>

        <p className="text-text-muted text-center mt-6 text-sm">
          Already have an account?{" "}
          <Link href="/login" className="text-accent-gold hover:text-accent-gold-hover font-bold">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
