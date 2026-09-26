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

// Clusters this build must never connect to: the dry-run cluster and an abandoned one.
// Matched on the cluster's domain so both connection-string forms are caught
// (cluster0.x.mongodb.net and cluster0-shard-00-00.x.mongodb.net).
const BLOCKED_CLUSTER_DOMAINS = ["mrr9bdi.mongodb.net", "gexvbm.mongodb.net"];

// Host part of a MongoDB connection string, without the username or password.
// Uses the last "@" so a password containing an unencoded "@" can't leak into the result.
export function mongoHosts(uri: string): string[] {
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
  const at = afterScheme.lastIndexOf("@");
  const hostPart = (at === -1 ? afterScheme : afterScheme.slice(at + 1)).split(/[/?]/)[0];
  return hostPart
    .split(",")
    .map((h) => h.replace(/:\d+$/, "").toLowerCase())
    .filter(Boolean);
}

// The connection string, after refusing a blocked cluster.
export function mongoUri(): string {
  const uri = requireEnv("MONGODB_URI");
  const hosts = mongoHosts(uri);
  if (!hosts.length) throw new Error("MONGODB_URI has no host");
  const blocked = hosts.find((h) => BLOCKED_CLUSTER_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`)));
  if (blocked) throw new Error(`MONGODB_URI points at ${blocked}, which this build must not use`);
  return uri;
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
