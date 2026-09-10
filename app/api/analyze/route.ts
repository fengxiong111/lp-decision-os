import { analyzeToken } from "@/cloud-oracle";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address")?.trim() ?? "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return Response.json({ error: "INVALID_EVM_ADDRESS", address }, { status: 400, headers: { "cache-control": "no-store" } });
  try { return Response.json(await analyzeToken(address), { headers: { "cache-control": "no-store", "x-oracle-schema": "lp-oracle-v3.0" } }); }
  catch (error) { return Response.json({ error: "ANALYSIS_FAILED", detail: error instanceof Error ? error.message : "UNKNOWN" }, { status: 502, headers: { "cache-control": "no-store" } }); }
}
