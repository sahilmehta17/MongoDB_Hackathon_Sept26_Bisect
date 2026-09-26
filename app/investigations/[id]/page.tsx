import type { Metadata } from "next";
import InvestigationReport from "./InvestigationReport";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `Investigation ${id} · Bisect` };
}

// The results page: a shell around the client view, which loads the investigation and follows it
// live while it runs.
export default async function InvestigationPage({ params }: Props) {
  const { id } = await params;
  return <InvestigationReport key={id} id={id} />;
}
