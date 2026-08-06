export const RAYDIUM_API_BASE = process.env.RAYDIUM_API_BASE ?? "https://api-v3.raydium.io";
export const RAYDIUM_RWA_PAGE = "https://raydium.io/liquidity-pools/?type=RWA";
// 默认只使用 Solana 官方免费公共端点；其它端点必须由用户显式配置。
export const SOLANA_RPC_DEFAULT = "https://api.mainnet.solana.com";
export const SOLANA_WS_DEFAULT = "wss://api.mainnet.solana.com";

// Solana 主网的官方 USDC Mint。资产池仍然由官方 RWA 发现结果动态决定。
export const USDC_MINT = process.env.RAYDIUM_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const RAYDIUM_PROGRAMS = {
  "AMM v4": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  CPMM: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
} as const;

// API 返回的 CLMM Program ID 大小写需保持链上原值；统一表用于校验和展示。
export const RAYDIUM_PROGRAM_IDS: Set<string> = new Set([
  RAYDIUM_PROGRAMS["AMM v4"],
  RAYDIUM_PROGRAMS.CPMM,
  RAYDIUM_PROGRAMS.CLMM,
]);

export function poolKindFromProgram(programId: string): "CLMM" | "CPMM" | "AMM v4" | null {
  if (programId === RAYDIUM_PROGRAMS["AMM v4"]) return "AMM v4";
  if (programId === RAYDIUM_PROGRAMS.CPMM) return "CPMM";
  if (programId === RAYDIUM_PROGRAMS.CLMM) return "CLMM";
  return null;
}

export const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
