import StageView from "@/app/components/stage/StageView";
import { DEMO_SESSION_ID } from "@/lib/story";

// The home page is the demo: the recorded session DEMO_SESSION_ID, step by step (/?session=apN for another).
export default async function Home({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const { session } = await searchParams;
  return <StageView id={session && /^ap\d+$/.test(session) ? session : DEMO_SESSION_ID} />;
}
