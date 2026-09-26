import { execSync } from "node:child_process";

// Required settings. There is no stub or offline mode: if a key is missing the app refuses to
// run instead of quietly producing fake results.
export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function dbName(): string {
  return requireEnv("MONGODB_DB");
}

// Short git commit of the running code: Vercel sets VERCEL_GIT_COMMIT_SHA; locally we ask git.
let commit: string | null = null;
export function gitCommit(): string {
  if (commit === null) {
    commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "";
    if (!commit) {
      try {
        commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      } catch {
        commit = "unknown";
      }
    }
  }
  return commit;
}
