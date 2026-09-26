import { redirect } from "next/navigation";
import { col } from "@/lib/memory/collections";

export const dynamic = "force-dynamic";

// "The story": the latest finished autopilot session (read-only lookup).
export default async function LatestStory({ searchParams }: { searchParams: Promise<{ try?: string; play?: string }> }) {
  const { try: tryIt, play } = await searchParams;
  const query = tryIt === "1" ? "?try=1" : play === "1" ? "?play=1" : "";
  const { sessions } = await col();
  const latest = await sessions.findOne({ status: "done" }, { sort: { finishedAt: -1 }, projection: { _id: 0, sessionId: 1 } });
  redirect(latest ? `/autopilot/${latest.sessionId}${query}` : "/autopilot");
}
