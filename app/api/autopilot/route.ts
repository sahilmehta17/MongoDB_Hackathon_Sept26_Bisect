import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { createSession } from "@/lib/autopilot/steps";
import { buildDemoStream } from "@/lib/autopilot/stream";
import { listTasks } from "@/lib/data";
import { getAutopilotSets, getCalibration, getLessonSeed } from "@/lib/data/stored";
import { col } from "@/lib/memory/collections";
import { autopilot } from "@/workflows/autopilot";

export const dynamic = "force-dynamic";

// Start the demo autopilot session, or return the one already running (never two at once).
export async function POST() {
  const { sessions } = await col();
  const running = await sessions.findOne({ status: { $in: ["running", "awaiting_decision"] } }, { projection: { _id: 0, sessionId: 1 } });
  if (running) return NextResponse.json({ sessionId: running.sessionId, alreadyRunning: true });

  const sets = await getAutopilotSets();
  if (!sets) return NextResponse.json({ error: "data/autopilot_sets.yaml hasn't been loaded yet" }, { status: 409 });
  const [training, seed, calibration] = await Promise.all([listTasks("training"), getLessonSeed(), getCalibration()]);
  const plan = buildDemoStream({
    trainingTaskIds: training.map((t) => t.taskId),
    gate: sets.gate,
    monitoring: sets.monitoring,
    harmful: seed.harmful,
    rewordings: calibration?.rewordings ?? {},
  });
  const sessionId = await createSession({ stream: plan.stream, sets });
  const { addEvent } = await import("@/lib/autopilot/steps");
  await addEvent(sessionId, { key: "plan", type: "session_started", msg: `demo branch: ${plan.notes.join(" · ")}` });
  const run = await start(autopilot, [{ sessionId }]);
  await sessions.updateOne({ sessionId }, { $set: { workflowRunId: run.runId } });
  return NextResponse.json({ sessionId, workflowRunId: run.runId, plan: plan.notes });
}

export async function GET() {
  const { sessions } = await col();
  const list = await sessions
    .find({}, { projection: { _id: 0, sessionId: 1, status: 1, activeVersionId: 1, activations: 1, createdAt: 1, finishedAt: 1 } })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();
  return NextResponse.json(list);
}
