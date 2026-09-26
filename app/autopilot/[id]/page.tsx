import type { Metadata } from "next";
import StoryPage from "./StoryPage";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ try?: string; play?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `The story of ${id} · Bisect` };
}

// The story of one agent: what it learned, what the tests and monitoring caught, what Bisect
// removed, and what the memory blocked, in order.
export default async function AutopilotStoryPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { try: tryIt, play } = await searchParams;
  return <StoryPage key={id} id={id} openTry={tryIt === "1"} autoPlay={play === "1" && tryIt !== "1"} />;
}
