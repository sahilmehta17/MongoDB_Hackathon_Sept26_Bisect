import { NextResponse } from "next/server";
import { gitCommit, mongoHosts } from "@/lib/env";
import { llm, MODEL } from "@/lib/llm";
import { getDb } from "@/lib/memory/db";
import { EMBED_DIMS, embedOne, VOYAGE_MODEL } from "@/lib/memory/embed";

// Always run at request time: a health check must never be a cached build-time answer.
export const dynamic = "force-dynamic";

type Check = { ok: boolean; ms?: number; error?: string; [k: string]: unknown };

async function timed(fn: () => Promise<Record<string, unknown>>): Promise<Check> {
  const t0 = Date.now();
  try {
    return { ok: true, ...(await fn()), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}

// Which cluster the connection string points at (host only, never the credentials).
function clusterHost(): string | null {
  const uri = process.env.MONGODB_URI;
  return uri ? mongoHosts(uri).join(",") : null;
}

// Checks Atlas, OpenRouter and Voyage with one real call each, and reports what is running.
export async function GET() {
  const [atlas, openrouter, voyage] = await Promise.all([
    timed(async () => {
      const db = await getDb();
      await db.command({ ping: 1 });
      return { cluster: clusterHost(), database: db.databaseName };
    }),
    timed(async () => {
      const r = await llm().chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: 5,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      });
      return { model: r.model, reply: r.choices[0]?.message?.content ?? "" };
    }),
    timed(async () => {
      const v = await embedOne("health check", "query");
      if (v.length !== EMBED_DIMS) throw new Error(`expected ${EMBED_DIMS} dims, got ${v.length}`);
      return { model: VOYAGE_MODEL, dims: v.length };
    }),
  ]);
  const ok = atlas.ok && openrouter.ok && voyage.ok;
  return NextResponse.json(
    { ok, commit: gitCommit(), cluster: clusterHost(), database: process.env.MONGODB_DB ?? null, atlas, openrouter, voyage },
    { status: ok ? 200 : 503 },
  );
}
