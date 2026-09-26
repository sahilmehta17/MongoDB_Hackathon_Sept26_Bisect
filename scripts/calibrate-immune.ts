// Calibrates the immune threshold (spec 6.4) from data/immune_calibration.yaml: rewordings of each
// convicted rule (should match it) and useful lessons (should match nothing). Scores are exactly
// what recognition sees: the proposal's stored query vector against the rule's document embedding,
// on Atlas' (1 + cosine) / 2 scale. Prints every similarity and picks a threshold with margin.
// The holdout rewordings are never read here.
// Usage: npm run calibrate-immune [-- --write]   (--write fixes the value in lib/immune/threshold.ts)
import { readFileSync, writeFileSync } from "node:fs";
import { parseCalibration } from "@/lib/data/stored";
import { yamlLessonSeed, yamlOptional } from "@/lib/data/yaml";
import { getClient } from "@/lib/memory/db";
import { cosine, embed } from "@/lib/memory/embed";
import { queryVector } from "@/lib/memory/lessons";

const atlas = (a: number[], b: number[]) => (1 + cosine(a, b)) / 2;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

async function main() {
  const cal = parseCalibration(yamlOptional("immune_calibration.yaml"));
  if (!cal) throw new Error("data/immune_calibration.yaml is missing or has no rewordings");
  const harmful = yamlLessonSeed().harmful.filter((h) => cal.rewordings[h.id]?.length);
  if (!harmful.length) throw new Error("no rewordings match the harmful lesson ids (H1, H2, H3)");
  const ruleVecs = await embed(harmful.map((h) => h.text), "document");

  const positives: { id: string; text: string; own: number; bestOther: number }[] = [];
  for (const h of harmful) {
    for (const text of cal.rewordings[h.id]) {
      const q = await queryVector(text);
      const scores = harmful.map((x, i) => ({ id: x.id, s: atlas(q, ruleVecs[i]) }));
      positives.push({
        id: h.id,
        text,
        own: scores.find((x) => x.id === h.id)!.s,
        bestOther: Math.max(0, ...scores.filter((x) => x.id !== h.id).map((x) => x.s)),
      });
    }
  }
  const negatives: { text: string; best: number; bestId: string }[] = [];
  for (const text of cal.useful) {
    const q = await queryVector(text);
    const scores = harmful.map((x, i) => ({ id: x.id, s: atlas(q, ruleVecs[i]) })).sort((a, b) => b.s - a.s);
    negatives.push({ text, best: scores[0].s, bestId: scores[0].id });
  }

  console.log("\nrewordings (should match their own rule):");
  for (const p of positives) console.log(`  ${p.id}  own ${r3(p.own).toFixed(3)}  best other ${r3(p.bestOther).toFixed(3)}  ${p.text}`);
  console.log("\nuseful lessons (should match no bad rule):");
  for (const n of negatives) console.log(`  best ${r3(n.best).toFixed(3)} (${n.bestId})  ${n.text}`);

  const minPos = Math.min(...positives.map((p) => p.own));
  const maxNeg = negatives.length ? Math.max(...negatives.map((n) => n.best)) : 0;
  const margin = minPos - maxNeg;
  // Halfway between the lowest rewording and the highest useful lesson. If they overlap, keep every
  // rewording above the line: a false match only costs a 5-run replay, never a wrong block.
  const threshold = r3(margin > 0 ? (minPos + maxNeg) / 2 : minPos - 0.001);
  console.log(`\nlowest rewording ${r3(minPos)}, highest useful lesson ${r3(maxNeg)}, margin ${r3(margin)}`);
  console.log(margin > 0 ? `threshold ${threshold} (halfway; ${r3(margin / 2)} on each side)` : `OVERLAP: threshold ${threshold} keeps every rewording; useful lessons above it will be replayed, not blocked`);
  console.log(`counts: ${positives.length} rewordings of ${harmful.length} rules, ${negatives.length} useful lessons`);

  if (process.argv.includes("--write")) {
    const file = "lib/immune/threshold.ts";
    const src = readFileSync(file, "utf8").replace(
      /export const IMMUNE_THRESHOLD: number \| null = [^;]+;/,
      `export const IMMUNE_THRESHOLD: number | null = ${threshold}; // calibrated ${new Date().toISOString().slice(0, 10)}: rewordings >= ${r3(minPos)}, useful <= ${r3(maxNeg)}, margin ${r3(margin)} (${positives.length} rewordings, ${negatives.length} useful)`,
    );
    writeFileSync(file, src);
    console.log(`wrote ${threshold} to ${file}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => (await getClient()).close());
