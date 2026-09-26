import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { createSession } from "@/lib/autopilot/steps";
import { buildDemoStream } from "@/lib/autopilot/stream";
import { listTasks } from "@/lib/data";
import { getAutopilotSets, getCalibration, getLessonSeed } from "@/lib/data/stored";
import { col } from "@/lib/memory/collections";
import { autopilot } from "@/workflows/autopilot";

export const dynamic = "force-dynamic";

// The demo configuration: the agent starts with the hand-written lessons U1-U5 (labelled seeded),
// then handles all 18 training requests plus the labelled demo branch.
const DEMO_SEED = ["U1", "U2", "U3", "U4", "U5"];
const DEMO_TRAINING = 18;

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
    trainingCount: DEMO_TRAINING,
  });
  const startWith = seed.useful.filter((u) => DEMO_SEED.includes(u.id)).map((u) => ({ id: u.id, text: u.text }));
  const sessionId = await createSession({ stream: plan.stream, sets, seed: startWith });
  const { addEvent } = await import("@/lib/autopilot/steps");
  await addEvent(sessionId, {
    key: "plan",
    type: "session_started",
    msg: `the agent starts with ${startWith.length} hand-written lessons (${startWith.map((u) => u.id).join(", ")}, labelled seeded) and handles ${DEMO_TRAINING} training requests · demo branch: ${plan.notes.join(" · ")}`,
  });
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
