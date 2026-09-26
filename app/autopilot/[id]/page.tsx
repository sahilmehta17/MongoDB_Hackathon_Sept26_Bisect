import type { Metadata } from "next";
import { MONITOR_EVERY, SESSION_MAX_MODEL_CALLS, SESSION_MAX_RUNS } from "@/lib/autopilot/steps";
import AutopilotSessionView from "./AutopilotSessionView";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Autopilot ${id} · Bisect` };
}

// One autopilot session: a shell around the client view, which loads the session and follows it
// live while it runs. The budget and monitoring cadence come from the autopilot code itself.
export default async function AutopilotSessionPage({ params }: Props) {
  const { id } = await params;
  return (
    <AutopilotSessionView
      key={id}
      id={id}
      limits={{ maxRuns: SESSION_MAX_RUNS, maxModelCalls: SESSION_MAX_MODEL_CALLS, monitorEvery: MONITOR_EVERY }}
    />
  );
}
