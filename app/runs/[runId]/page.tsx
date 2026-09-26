import type { Metadata } from "next";
import RunTrace from "../RunTrace";

type Props = { params: Promise<{ runId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { runId } = await params;
  return { title: `Run ${runId} · Bisect` };
}

// The trace of one agent run: what it was asked, which lessons it saw, what it did, and how it was checked.
export default async function RunPage({ params }: Props) {
  const { runId } = await params;
  return <RunTrace key={runId} runId={runId} />;
}
