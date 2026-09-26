import Link from "next/link";
import StageView from "@/app/components/stage/StageView";
import { col } from "@/lib/memory/collections";

export const dynamic = "force-dynamic";

// The home page is the demo: the latest finished autopilot session, step by step (read-only lookup).
export default async function Home() {
  const { sessions } = await col();
  const latest = await sessions.findOne({ status: "done" }, { sort: { finishedAt: -1 }, projection: { _id: 0, sessionId: 1 } });
  if (!latest) {
    return (
      <main style={{ maxWidth: 880, margin: "0 auto", padding: "24px 16px" }}>
        <p>No finished autopilot session yet.</p>
        <Link href="/autopilot">All runs</Link>
      </main>
    );
  }
  return <StageView id={latest.sessionId} />;
}
