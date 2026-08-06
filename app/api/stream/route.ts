import { getDashboardSnapshot } from "@/services/raydium/snapshot";
import { sanitizeNullSemantics } from "@/services/shared/null-semantics";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await getDashboardSnapshot();
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: 15000\n\nevent: snapshot\ndata: ${JSON.stringify(sanitizeNullSemantics(snapshot))}\n\n`));
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
    },
  });
}
