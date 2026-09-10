import { analyzeToken } from "../cloud-oracle/index";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const worker = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/analyze") return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    if (request.method !== "GET") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { allow: "GET" } });
    const address = url.searchParams.get("address")?.trim() ?? "";
    if (!ADDRESS.test(address)) return Response.json({ error: "INVALID_EVM_ADDRESS", address }, { status: 400, headers: { "cache-control": "no-store" } });
    try {
      return Response.json(await analyzeToken(address), { headers: { "cache-control": "no-store", "x-oracle-schema": "lp-oracle-v3.0" } });
    } catch (error) {
      return Response.json({ error: "ANALYSIS_FAILED", detail: error instanceof Error ? error.message : "UNKNOWN" }, { status: 502, headers: { "cache-control": "no-store" } });
    }
  },
};

export default worker;
