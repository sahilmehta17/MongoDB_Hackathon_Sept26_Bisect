import type { Metadata } from "next";
import { MONITOR_EVERY, SESSION_MAX_MODEL_CALLS, SESSION_MAX_RUNS } from "@/lib/autopilot/steps";
import AutopilotSessionView from "../AutopilotSessionView";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Autopilot ${id}: full details · Bisect` };
}

// The full autopilot console (every event with its evidence), behind the story page.
export default async function AutopilotDetailsPage({ params }: Props) {
  const { id } = await params;
  return (
    <AutopilotSessionView
      key={id}
      id={id}
      limits={{ maxRuns: SESSION_MAX_RUNS, maxModelCalls: SESSION_MAX_MODEL_CALLS, monitorEvery: MONITOR_EVERY }}
    />
  );
}
