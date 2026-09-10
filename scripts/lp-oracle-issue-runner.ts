import { readFile } from "node:fs/promises";
import { analyzeToken } from "../cloud-oracle/index";
import type { AnalysisResult, BlockedReason, RangeCandidate, SourceArtifact } from "../cloud-oracle/schema/types";

const EVM_ADDRESS = /^0x[a-f0-9]{40}$/i;
const ISSUE_TITLE = /^\[LP_ORACLE\]\s+(0x[a-f0-9]{40})\s*$/i;
const RESULT_MARKER = "[LP_ORACLE_RESULT]";

export type IssueEvent = {
  issue?: { number?: number; title?: string };
  repository?: { full_name?: string };
};

export type QueueOutput = {
  timestamp: string;
  address: string;
  sources: Array<{ source: SourceArtifact["source"]; status: SourceArtifact["status"]; fetchedAt: string; blocked: BlockedReason[]; error: string | null }>;
  blocked: BlockedReason[];
  selected_pool: { chain: string | null; pair: string | null; dex: string | null } | null;
  current_price: number | null;
  "24h": { volume_usd: number | null; fee_proxy_usd: number | null };
  "7d": { volume_usd: number | null; fee_proxy_usd: number | null } | null;
  fee_velocity: number | null;
  core: RangeCandidate;
  buffer: RangeCandidate;
  action: AnalysisResult["decision"]["action"];
  confidence: number | null;
};

export function parseAddressFromIssueTitle(title: string): string | null {
  const match = title.match(ISSUE_TITLE);
  return match && EVM_ADDRESS.test(match[1]) ? match[1] : null;
}

function pairFromAnalysis(result: AnalysisResult): { chain: string | null; pair: string | null; dex: string | null } | null {
  const source = result.sources.find((item) => item.source === "dexscreener" && item.status === "READY");
  const payload = source?.payload;
  const pair = payload && typeof payload === "object" && "pair" in payload && payload.pair && typeof payload.pair === "object"
    ? payload.pair as { pairAddress?: string; dexId?: string; chainId?: string }
    : null;
  return source ? { chain: source.chainId, pair: pair?.pairAddress ?? null, dex: pair?.dexId ?? null } : null;
}

export function toQueueOutput(result: AnalysisResult): QueueOutput {
  const core = result.candidates.find((item) => item.kind === "CORE") ?? result.candidates[0];
  const buffer = result.candidates.find((item) => item.kind === "BUFFER") ?? result.candidates[1];
  const blocked = [...new Set([...result.decision.blockedReasons, ...result.sources.flatMap((item) => item.blockedReasons)])];
  const volume24h = core?.replay.observedVolumeUsd ?? null;
  const fee24h = core?.replay.feeProxyUsd ?? null;
  return {
    timestamp: result.analyzedAt,
    address: result.request.address,
    sources: result.sources.map((item) => ({ source: item.source, status: item.status, fetchedAt: item.fetchedAt, blocked: item.blockedReasons, error: item.error })),
    blocked,
    selected_pool: pairFromAnalysis(result),
    current_price: result.token.priceUsd,
    "24h": { volume_usd: volume24h, fee_proxy_usd: fee24h },
    "7d": null,
    fee_velocity: fee24h === null ? null : fee24h / 24,
    core,
    buffer,
    action: result.decision.action,
    confidence: result.authority.confidence,
  };
}

export function renderComment(output: QueueOutput): string {
  return `${RESULT_MARKER}\n\nLP Oracle V3 result (machine-readable JSON):\n\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n\n区间：Core ${formatRange(output.core)}；Buffer ${formatRange(output.buffer)}。Action: ${output.action}。Confidence: ${formatNumber(output.confidence)}。`;
}

function formatNumber(value: number | null): string { return value === null ? "UNKNOWN" : String(value); }
function formatRange(candidate: RangeCandidate): string { return candidate.lowerPriceUsd === null || candidate.upperPriceUsd === null ? "UNKNOWN" : `${candidate.lowerPriceUsd}–${candidate.upperPriceUsd}`; }

async function githubRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, { ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...init.headers } });
}

async function commentIssue(repository: string, issueNumber: number, body: string, token: string): Promise<void> {
  const response = await githubRequest(`/repos/${repository}/issues/${issueNumber}/comments`, token, { method: "POST", body: JSON.stringify({ body }), headers: { "content-type": "application/json" } });
  if (!response.ok) throw new Error(`GITHUB_COMMENT_FAILED_${response.status}`);
}

async function hasResultComment(repository: string, issueNumber: number, token: string): Promise<boolean> {
  const response = await githubRequest(`/repos/${repository}/issues/${issueNumber}/comments?per_page=100`, token);
  if (!response.ok) throw new Error(`GITHUB_READ_COMMENTS_FAILED_${response.status}`);
  const comments = await response.json() as Array<{ body?: string }>;
  return comments.some((comment) => comment.body?.includes(RESULT_MARKER));
}

export async function runQueue(event: IssueEvent, token?: string, shouldComment = true): Promise<QueueOutput | null> {
  const title = event.issue?.title ?? "";
  const address = parseAddressFromIssueTitle(title);
  if (!address) return null;
  const result = toQueueOutput(await analyzeToken(address));
  if (shouldComment) {
    const repository = event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
    const issueNumber = event.issue?.number;
    const githubToken = token ?? process.env.GITHUB_TOKEN;
    if (!repository || !issueNumber || !githubToken) throw new Error("GITHUB_ISSUE_CONTEXT_MISSING");
    if (!(await hasResultComment(repository, issueNumber, githubToken))) await commentIssue(repository, issueNumber, renderComment(result), githubToken);
  }
  return result;
}

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(await readFile(eventPath, "utf8")) as IssueEvent : { issue: { title: "" } };
  const output = await runQueue(event, process.env.GITHUB_TOKEN, process.argv.includes("--no-comment") ? false : true);
  if (output) console.log(JSON.stringify(output, null, 2));
  else { console.error("INVALID_LP_ORACLE_ISSUE_TITLE"); process.exitCode = 2; }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
