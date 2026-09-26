import type { Metadata } from "next";
import Link from "next/link";
import { MONITOR_EVERY } from "@/lib/autopilot/steps";
import { AutopilotHome } from "./[id]/AutopilotSessionView";
import InvestigationsList from "./InvestigationsList";

export const metadata: Metadata = { title: "All runs · Bisect" };

// All runs: the autopilot sessions (with the button that starts the demo) and every investigation.
export default function AllRunsPage() {
  return (
    <>
      <AutopilotHome monitorEvery={MONITOR_EVERY} />
      <InvestigationsList />
      <p style={{ maxWidth: 1100, margin: "0 auto 48px", padding: "0 16px" }}>
        <Link href="/overview">Planted test cases and measured results ▸</Link>
      </p>
    </>
  );
}
