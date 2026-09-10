export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(
    {
      status: "ok",
      service: "lp-oracle-v3",
      schema: "lp-oracle-v3.0",
      timestamp: new Date().toISOString()
    },
    { headers: { "cache-control": "no-store" } }
  );
}
