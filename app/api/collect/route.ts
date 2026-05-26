import { collect42Metrics } from "@/scripts/collect-42";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const expected = process.env.COLLECTOR_SECRET;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!expected || provided !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  await collect42Metrics();
  return Response.json({ ok: true, collectedAt: new Date().toISOString() });
}
