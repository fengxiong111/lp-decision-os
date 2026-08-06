import type { ProtocolConnector } from "@/packages/connectors/src";
import { collectDashboardSnapshot } from "@/services/raydium/snapshot";

export const raydiumConnector: ProtocolConnector = {
  id: "raydium",
  label: "Raydium",
  chain: "Solana Mainnet",
  capabilities: [
    "discover-pools",
    "pool-state",
    "ticks",
    "volume",
    "fees",
    "swap-stream",
    "liquidity-stream",
    "position-stream",
    "farm-stream",
    "routing",
    "execution",
  ],
  discoverPools: async () => (await collectDashboardSnapshot()).pools,
};
