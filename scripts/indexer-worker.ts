import { runRealtimeWorker } from "@/services/indexer/realtime";

runRealtimeWorker().catch((error) => {
  console.error("[realtime] worker fatal:", error);
  process.exitCode = 1;
});
