"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

export default function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    setSubmitting(true);
    try {
      await signIn(email, password);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in");
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
        <p className="text-center text-sm font-bold tracking-wide text-ink mb-3">Cowboy City & The Realm</p>
        <h1 className="text-3xl font-bold text-ink text-center mb-2">
          Welcome Back, Partner
        </h1>
        <p className="text-text-muted text-center mb-8">
          Sign in to continue your tale in Cowboy City.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="form-input"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm text-center">{error}</p>
          )}

          <button type="submit" disabled={submitting} className="btn w-full">
            {submitting ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <p className="text-text-muted text-center mt-6 text-sm">
          New to the realm?{" "}
          <Link href="/signup" className="text-accent-gold hover:text-accent-gold-hover font-bold">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
