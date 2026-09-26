import { redirect } from "next/navigation";
import { DEMO_SESSION_ID } from "@/lib/story";

// "Session log": the full chronological log of the recorded demo session (the one the home page tells).
export default async function DemoSessionLog({ searchParams }: { searchParams: Promise<{ try?: string; play?: string }> }) {
  const { try: tryIt, play } = await searchParams;
  const query = tryIt === "1" ? "?try=1" : play === "1" ? "?play=1" : "";
  redirect(`/autopilot/${DEMO_SESSION_ID}${query}`);
}
