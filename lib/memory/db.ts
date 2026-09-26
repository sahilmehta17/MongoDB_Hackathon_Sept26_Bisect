import { MongoClient, type Db } from "mongodb";
import { dbName, mongoUri } from "@/lib/env";

// One client per process, reused across hot reloads and warm serverless invocations.
// The cluster guard runs on every call, and a changed connection string gets a new client,
// so a client opened before a settings change is never reused.
const g = globalThis as unknown as { _bisectMongo?: { uri: string; client: Promise<MongoClient> } };

export function getClient(): Promise<MongoClient> {
  const uri = mongoUri();
  if (g._bisectMongo?.uri !== uri) {
    const old = g._bisectMongo;
    const client = new MongoClient(uri, { appName: "Bisect", maxPoolSize: 20 }).connect();
    const entry = { uri, client };
    g._bisectMongo = entry;
    client.catch(() => {
      if (g._bisectMongo === entry) g._bisectMongo = undefined; // let the next call retry instead of caching the failure
    });
    old?.client.then((c) => c.close()).catch(() => {});
  }
  return g._bisectMongo!.client;
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(dbName());
}
