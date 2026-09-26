// Tests a private holdout of rewordings against immune memory, once, after the threshold is fixed
// (spec 6.4). The file stays outside the repo; results are recorded as recognitions (source
// "holdout", label "planted") and printed as-is.
// Usage: npm run holdout-immune -- <path/to/holdout.yaml> --base <versionId>
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { recognize } from "@/lib/immune/recognize";
import { getClient } from "@/lib/memory/db";

async function main() {
  const file = process.argv[2];
  const bi = process.argv.indexOf("--base");
  const base = bi > -1 ? process.argv[bi + 1] : null;
  if (!file || !base) throw new Error("usage: npm run holdout-immune -- <holdout.yaml> --base <versionId>");
  const data = parse(readFileSync(file, "utf8")) as Record<string, string[]>;
  const items = Object.entries(data).flatMap(([rule, texts]) => (Array.isArray(texts) ? texts.map((text) => ({ rule, text })) : []));
  let blocked = 0;
  for (const { rule, text } of items) {
    const r = await recognize({ text, baseVersionId: base, label: "planted", source: "holdout" });
    const top = r.replays.find((x) => x.antibodyId === r.blockedBy) ?? r.replays[0];
    if (r.decision === "immune_blocked") blocked++;
    const match = r.matches.length ? r.matches.map((m) => `${m.antibodyId} ${m.score.toFixed(3)}`).join(", ") : "none";
    const replay = top ? `${top.probe.counts.targetFail}/${top.probe.trials} failed` : "-";
    const untestable = r.untestable.length ? ` untestable: ${r.untestable.map((u) => `${u.antibodyId} (base ${u.baseLabel})`).join(", ")}` : "";
    console.log(`${rule}  ${r.decision.padEnd(14)} match: ${match.padEnd(22)} replay: ${replay.padEnd(10)} ${(r.ms / 1000).toFixed(1)} s, ${r.runs} runs${untestable}  "${text}"`);
  }
  console.log(`\nblocked ${blocked} of ${items.length} holdout rewordings (threshold never tuned on them), base ${base}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => (await getClient()).close());
