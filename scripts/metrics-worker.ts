import { runMetricsWorker } from "@/services/indexer/metrics-worker";

runMetricsWorker().catch((error) => {
  console.error("[metrics] worker fatal:", error);
  process.exitCode = 1;
});
