import { NextResponse } from "next/server";
import { NotCalibratedError, recognize } from "@/lib/immune/recognize";
import { getVersion } from "@/lib/memory/lessons";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_CHARS = 200;

// "Propose a rule": a visitor submits a rule; recognition decides with fresh runs.
// POST { text, baseVersionId } → Recognition
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { text?: string; baseVersionId?: string };
  const text = (body.text ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_CHARS) {
    return NextResponse.json({ error: `a rule of 1 to ${MAX_CHARS} characters is required` }, { status: 400 });
  }
  if (!body.baseVersionId) return NextResponse.json({ error: "baseVersionId is required" }, { status: 400 });
  try {
    await getVersion(body.baseVersionId);
  } catch {
    return NextResponse.json({ error: `unknown version ${body.baseVersionId}` }, { status: 400 });
  }
  try {
    return NextResponse.json(await recognize({ text, baseVersionId: body.baseVersionId, label: "visitor", source: "immune_page" }));
  } catch (e) {
    if (e instanceof NotCalibratedError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
