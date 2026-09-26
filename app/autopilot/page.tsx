import type { Metadata } from "next";
import { MONITOR_EVERY } from "@/lib/autopilot/steps";
import { AutopilotHome } from "./[id]/AutopilotSessionView";

export const metadata: Metadata = { title: "Autopilot · Bisect" };

// The autopilot sessions, and the button that starts the demo (or opens the one already running).
export default function AutopilotPage() {
  return <AutopilotHome monitorEvery={MONITOR_EVERY} />;
}
