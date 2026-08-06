import { runBackfillWorker } from "@/services/indexer/backfill";

runBackfillWorker().catch((error) => {
  console.error("[backfill] worker fatal:", error);
  process.exitCode = 1;
});
