import { requireEnv } from "@/lib/env";

// Voyage embeddings for lessons, tasks and (later) antibodies. No fallback: without a key we refuse.
export const VOYAGE_MODEL = "voyage-3.5-lite";
export const EMBED_DIMS = 1024;

export async function embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
  const key = requireEnv("VOYAGE_API_KEY");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: kind }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`Voyage embeddings failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

export async function embedOne(text: string, kind: "document" | "query"): Promise<number[]> {
  return (await embed([text], kind))[0];
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}
