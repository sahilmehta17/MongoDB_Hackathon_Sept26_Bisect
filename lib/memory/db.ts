import { MongoClient, type Db } from "mongodb";
import { dbName, requireEnv } from "@/lib/env";

// One client per process, reused across hot reloads and warm serverless invocations.
const g = globalThis as unknown as { _mongo?: Promise<MongoClient> };

export function getClient(): Promise<MongoClient> {
  if (!g._mongo) {
    const client = new MongoClient(requireEnv("MONGODB_URI"), { appName: "Bisect", maxPoolSize: 20 });
    g._mongo = client.connect().catch((e) => {
      g._mongo = undefined; // let the next call retry instead of caching the failure
      throw e;
    });
  }
  return g._mongo;
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(dbName());
}
