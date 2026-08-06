import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const CONFIG_VERSION = 1;

type StoredWalletConfig = {
  version: number;
  address: string | null;
  updatedAt: string;
};

function configPath(): string {
  if (process.env.LP_WALLET_CONFIG_PATH) return process.env.LP_WALLET_CONFIG_PATH;
  const localPath = path.join(/*turbopackIgnore: true*/ process.cwd(), ".local-data", "read-only-wallet.json");
  return existsSync(localPath) ? localPath : path.join(/*turbopackIgnore: true*/ process.cwd(), "db", "read-only-wallet.json");
}

function decodeBase58(value: string): Uint8Array | null {
  let number = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) return null;
    number = number * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number % 256n));
    number /= 256n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function validateReadOnlyAddress(value: unknown): { valid: true; address: string } | { valid: false; error: string } {
  if (typeof value !== "string" || value.trim().length === 0) return { valid: false, error: "请输入公开 Solana 地址" };
  const address = value.trim();
  if (address.length > 64) return { valid: false, error: "地址长度异常；只接受 32 字节公钥，不接受私钥" };
  const decoded = decodeBase58(address);
  if (!decoded || decoded.length !== 32) return { valid: false, error: "地址不是有效的 Base58 32 字节公钥" };
  return { valid: true, address };
}

function readStoredConfig(): StoredWalletConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<StoredWalletConfig>;
    if (parsed.version !== CONFIG_VERSION || !Object.prototype.hasOwnProperty.call(parsed, "address")) return null;
    return { version: CONFIG_VERSION, address: typeof parsed.address === "string" ? parsed.address : null, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString() };
  } catch {
    return null;
  }
}

export function getConfiguredReadOnlyAddress(): string | null {
  const stored = readStoredConfig();
  if (stored) return stored.address;
  const environmentAddress = process.env.READ_ONLY_SOLANA_ADDRESS;
  return validateReadOnlyAddress(environmentAddress).valid ? environmentAddress!.trim() : null;
}

function writeConfig(address: string | null): void {
  const target = configPath();
  mkdirSync(path.dirname(target), { recursive: true });
  const payload: StoredWalletConfig = { version: CONFIG_VERSION, address, updatedAt: new Date().toISOString() };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function saveReadOnlyAddress(value: unknown): { address: string } | { error: string } {
  const result = validateReadOnlyAddress(value);
  if (!result.valid) return result;
  writeConfig(result.address);
  return { address: result.address };
}

export function removeReadOnlyAddress(): void {
  writeConfig(null);
}
