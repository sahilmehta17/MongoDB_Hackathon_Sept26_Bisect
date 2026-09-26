// Everything /autopilot/[id] shows, read from saved records.
import { getSession } from "@/lib/autopilot/steps";
import { costOf } from "@/lib/bisect/trials";
import { col } from "@/lib/memory/collections";
import { getVersion } from "@/lib/memory/lessons";
import type { AutopilotView, Cost } from "@/lib/types";

export async function autopilotView(sessionId: string): Promise<AutopilotView> {
  const session = await getSession(sessionId);
  const { recognitions, lessons, versions } = await col();
  const recIds = (await recognitions.find({ sessionId }, { projection: { recognitionId: 1 } }).toArray()).map((r) => r.recognitionId);
  const recCosts = await Promise.all(recIds.map((id) => costOf(id)));
  const immuneCost = recCosts.reduce<Cost>(
    (a, c) => ({ runs: a.runs + c.runs, modelCalls: a.modelCalls + c.modelCalls, tokens: a.tokens + c.tokens, errors: a.errors + c.errors }),
    { runs: 0, modelCalls: 0, tokens: 0, errors: 0 },
  );
  const versionIds = [...new Set(session.events.map((e) => e.versionId).filter((v): v is string => !!v))];
  const vs = await versions.find({ versionId: { $in: versionIds } }, { projection: { change: 1 } }).toArray();
  const lessonIds = [...new Set([...vs.map((v) => v.change?.lessonId), ...session.events.map((e) => e.lessonId)].filter((x): x is string => !!x))];
  const docs = await lessons.find({ lessonId: { $in: lessonIds } }, { projection: { _id: 0, lessonId: 1, text: 1, origin: 1 } }).toArray();
  const active = await getVersion(session.activeVersionId);
  const end = session.finishedAt ? new Date(session.finishedAt).getTime() : Date.now();
  return {
    session,
    cost: await costOf(sessionId),
    immuneCost,
    lessons: Object.fromEntries(docs.map((l) => [l.lessonId, { text: l.text, origin: l.origin }])),
    activeLessonIds: active.activeLessonIds,
    elapsedMs: end - new Date(session.createdAt).getTime(),
  };
}
