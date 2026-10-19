import { version as packageVersion } from "../../package.json";

/**
 * Build stamp (bug-reporting design §2.3): "v0.1.0 · a1b2c3d · production".
 *
 * Sourced at build time from Vercel's git environment when the project
 * exposes it to the client bundle (NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA /
 * NEXT_PUBLIC_VERCEL_ENV), with the package.json version as the version
 * fallback. Rendered in the site footer so a member can quote the build in
 * a Discord message when the site itself won't load, and attached to bug
 * reports (with consent) so triage knows which code the reporter was running.
 */
export function getBuildId(): string {
  const sha = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  const env =
    process.env.NEXT_PUBLIC_VERCEL_ENV ||
    (process.env.NODE_ENV === "production" ? "production" : "local");
  return `v${packageVersion} · ${sha || "local"} · ${env}`;
}
