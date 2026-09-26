// Builds a controlled lesson history from data/lessons_seed.yaml: an empty root version, then one
// version per useful lesson (in seed order), with one planted harmful lesson inserted after the
// k-th useful lesson. The planted lesson, its version and its failing task are recorded on the
// history as ground truth, so every investigation on it can be scored against the right answer.
// Usage: npm run build-history -- H1@3 [--task refund_timeout_07]
import { yamlLessonSeed } from "@/lib/data/yaml";
import { getClient } from "@/lib/memory/db";
import { appendVersion, createHistory, setGroundTruth } from "@/lib/memory/histories";
import { addLesson, createVersion } from "@/lib/memory/lessons";

async function main() {
  const spec = process.argv.slice(2).find((a) => /^H\d+@\d+$/.test(a));
  if (!spec) throw new Error("usage: npm run build-history -- H1@3 [--task <taskId>]");
  const [seedId, at] = [spec.split("@")[0], Number(spec.split("@")[1])];
  const seed = yamlLessonSeed();
  const planted = seed.harmful.find((h) => h.id === seedId);
  if (!planted?.targetAssertion || !planted.triggerTasks?.length) throw new Error(`${seedId} has no target or trigger tasks`);
  if (at < 0 || at > seed.useful.length) throw new Error(`position must be 0..${seed.useful.length}`);
  const ti = process.argv.indexOf("--task");
  const failingTaskId = ti > -1 ? process.argv[ti + 1] : planted.triggerTasks[0];

  const history = await createHistory({ note: `${seed.useful.length} useful lessons, ${seedId} planted after #${at}` });
  let versionId = history.versionIds[0];
  console.log(`${history.historyId}: ${versionId} (root, no lessons)`);

  let gt: { lessonId: string; versionId: string } | null = null;
  const add = async (text: string, origin: "seeded" | "planted", id: string) => {
    const lesson = await addLesson(text, { origin, seedId: id });
    const v = await createVersion({
      parentVersionId: versionId,
      change: { op: "add", lessonId: lesson.lessonId },
      label: origin,
      createdBy: "seed",
      note: `${origin} ${id}`,
    });
    await appendVersion(history.historyId, v.versionId);
    versionId = v.versionId;
    console.log(`${v.versionId}: +${lesson.lessonId} ${origin === "planted" ? "[PLANTED] " : ""}${id}  ${text}`);
    return { lessonId: lesson.lessonId, versionId: v.versionId };
  };

  for (let k = 0; k <= seed.useful.length; k++) {
    if (k === at) gt = await add(planted.text, "planted", seedId);
    if (k < seed.useful.length) await add(seed.useful[k].text, "seeded", seed.useful[k].id);
  }
  await setGroundTruth(history.historyId, {
    seedId,
    lessonId: gt!.lessonId,
    versionId: gt!.versionId,
    failingTaskId,
    targetAssertion: planted.targetAssertion,
  });
  console.log(`\nhistory ${history.historyId}: current ${versionId}`);
  console.log(`ground truth: ${seedId} = ${gt!.lessonId} added in ${gt!.versionId}; breaks ${failingTaskId} / ${planted.targetAssertion}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => (await getClient()).close());
