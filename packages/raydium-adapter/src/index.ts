export type RaydiumPoolKind = "AMM_V4" | "CPMM" | "CLMM" | "FARM" | "LAUNCHLAB" | "PERPS" | "UNKNOWN";

export type RaydiumAdapterCapabilities = {
  poolDiscovery: boolean;
  feeConfiguration: boolean;
  swapParsing: boolean;
  tickParsing: boolean;
};

export type RaydiumAdapter = {
  name: "raydium";
  capabilities: RaydiumAdapterCapabilities;
};

export const raydiumAdapter: RaydiumAdapter = {
  name: "raydium",
  capabilities: {
    poolDiscovery: true,
    feeConfiguration: true,
    swapParsing: true,
    tickParsing: true,
  },
};

