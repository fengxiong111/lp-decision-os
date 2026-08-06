import type { PoolSnapshot, ProtocolId, WindowKey } from "@/packages/models/src";

export type ConnectorCapability =
  | "discover-pools"
  | "pool-state"
  | "ticks"
  | "volume"
  | "fees"
  | "swap-stream"
  | "liquidity-stream"
  | "position-stream"
  | "farm-stream"
  | "routing"
  | "execution";

export type ProtocolConnector = {
  id: ProtocolId;
  label: string;
  chain: string;
  capabilities: ConnectorCapability[];
  discoverPools: (options?: { window?: WindowKey; capital?: number }) => Promise<PoolSnapshot[]>;
};
