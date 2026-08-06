import type { PoolVerification } from "@/packages/models/src";
import type { RaydiumPoolInfo } from "@/services/raydium/api";
import type { RaydiumPoolKeys } from "@/services/raydium/keys";
import { verifyPoolAccounts, verifyTokenAndVaultAccounts, type AccountVerification, type RpcProvider } from "@/services/rpc/pool";

export async function reconcilePools(input: {
  provider: RpcProvider | null;
  pools: RaydiumPoolInfo[];
  keys: Map<string, RaydiumPoolKeys>;
  slot: number | null;
}): Promise<{ verification: Map<string, PoolVerification>; error: string | null }> {
  const poolAccounts = await verifyPoolAccounts(input.provider, input.pools.map((pool) => pool.id));
  const addresses = input.pools.flatMap((pool) => {
    const keys = input.keys.get(pool.id);
    return [pool.mintA.address, pool.mintB.address, keys?.vaultA, keys?.vaultB].filter((value): value is string => Boolean(value));
  });
  const tokenAccounts = await verifyTokenAndVaultAccounts(input.provider, addresses);
  const verification = new Map<string, PoolVerification>();
  const now = new Date().toISOString();

  for (const pool of input.pools) {
    const account: AccountVerification | undefined = poolAccounts.accounts.get(pool.id);
    const keys = input.keys.get(pool.id);
    const mintA = tokenAccounts.accounts.get(pool.mintA.address);
    const mintB = tokenAccounts.accounts.get(pool.mintB.address);
    const vaultA = keys?.vaultA ? tokenAccounts.accounts.get(keys.vaultA) : undefined;
    const vaultB = keys?.vaultB ? tokenAccounts.accounts.get(keys.vaultB) : undefined;
    const mintsVerified = Boolean(
      mintA?.exists && mintA.tokenProgram && mintA.decimals === pool.mintA.decimals &&
      mintB?.exists && mintB.tokenProgram && mintB.decimals === pool.mintB.decimals,
    );
    const vaultsVerified = Boolean(
      keys?.vaultA && keys.vaultB && vaultA?.exists && vaultA.tokenProgram && vaultA.mint === pool.mintA.address &&
      vaultB?.exists && vaultB.tokenProgram && vaultB.mint === pool.mintB.address,
    );
    const programVerified = Boolean(account?.exists && account.programVerified && account.owner === pool.programId);
    verification.set(pool.id, {
      poolAccountExists: Boolean(account?.exists),
      poolOwner: account?.owner ?? null,
      programVerified,
      mintsVerified,
      vaultsVerified,
      active: Boolean(account?.exists && programVerified),
      verifiedAt: account?.exists ? now : null,
      slot: input.slot ?? poolAccounts.slot,
    });
  }

  return {
    verification,
    error: poolAccounts.error ?? tokenAccounts.error,
  };
}
