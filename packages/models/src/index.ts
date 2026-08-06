export type ProtocolId =
  | "raydium"
  | "orca"
  | "meteora"
  | "jupiter"
  | "phoenix"
  | "openbook";

export type PoolKind = "CLMM" | "CPMM" | "AMM v4";

export type WindowKey = "1m" | "5m" | "30m" | "1h" | "6h" | "12h" | "24h";

export const WINDOW_KEYS: WindowKey[] = ["1m", "5m", "30m", "1h", "6h", "12h", "24h"];

export type SourceRef = {
  label: string;
  url: string;
  observedAt: string;
  status: "live" | "unavailable" | "derived";
};

export type WindowMetric = {
  window: WindowKey;
  volume: number | null;
  fee: number | null;
  grossFeeUsd: number | null;
  lpFeeUsd: number | null;
  swapCount: number | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  uniqueWalletCount: number | null;
  tvlStart: number | null;
  tvlEnd: number | null;
  activeTvl: number | null;
  feeDensity: number | null;
  liquidityVelocity: number | null;
  routeShare: number | null;
  coverageRatio: number | null;
  status: BackfillStatus;
  firstEventAt: string | null;
  lastEventAt: string | null;
  asOf: string | null;
  apr: number | null;
  source: "event-index" | "raydium-api-v3" | "unavailable";
  sourceLabel: string;
  observedAt: string | null;
  available: boolean;
};

export type BackfillStatus = "COMPLETE" | "PARTIAL" | "RUNNING" | "BACKFILLING" | "UNAVAILABLE" | "STALLED" | "BLOCKED" | "LIVE" | "INVALID";

export type WindowCrossCheck = {
  expectedBuckets: number;
  observedBuckets: number;
  matches: boolean | null;
  detail: string;
};

export type SwapEventRecord = {
  poolId: string;
  signature: string;
  instructionIndex?: number;
  trader?: string | null;
  slot: number;
  blockTime: string;
  receivedAt?: string;
  volume: number;
  fee: number | null;
  parsedAt: string;
  persistedAt: string | null;
  parseLatencyMs: number | null;
  persistenceLatencyMs: number | null;
  source: "rpc-replay" | "websocket" | "geyser";
  programVersion: string | null;
  inputMint: string | null;
  outputMint: string | null;
  actualAmountInAtomic: string | null;
  actualAmountOutAtomic: string | null;
  baseFeeRate: number | null;
  dynamicFeeRate: number | null;
  effectiveFeeRate: number | null;
  grossTradeFeeAtomic: string | null;
  protocolFeeAtomic: string | null;
  fundFeeAtomic: string | null;
  lpFeeAtomic: string | null;
  token2022TransferFeeAtomic: string | null;
  priceUsd: number | null;
  feeUsd: number | null;
};

export type EventWindowCoverage = {
  eventCount: number;
  poolCount: number;
  firstSlot: number | null;
  lastSlot: number | null;
  firstEventAt: string | null;
  lastEventAt: string | null;
  completeness: number | null;
  persisted: boolean;
  source: string;
  windowStart: string | null;
  windowEnd: string | null;
  startSlot: number | null;
  endSlot: number | null;
  expectedSlotRange: { start: number; end: number } | null;
  signaturesDiscovered: number;
  transactionsFetched: number;
  transactionsSuccessful: number;
  transactionsFailed: number;
  swapsParsed: number;
  swapsRejected: number;
  duplicatesRemoved: number;
  unknownInstructions: number | null;
  gapSlots: number | null;
  coverageRatio: number | null;
  firstEventTime: string | null;
  lastEventTime: string | null;
  backfillStatus: BackfillStatus;
  /** 统一 raw 12h 回补派生的稳定进度证据。百分比范围为 0–100。 */
  targetPoolCount?: number;
  completedPoolCount?: number;
  timeCoverageRatio?: number | null;
  etaMs?: number | null;
  etaAt?: string | null;
  oldestCoveredAt?: string | null;
  lastProgressAt?: string | null;
  requestsLast5m?: number;
  successfulTransactionsLast5m?: number;
  rpc429Last5m?: number;
  stalledPoolCount?: number;
  blockedPoolCount?: number;
  progressError?: string | null;
  transactionsPerMinute?: number | null;
  completedPoolsLast5m?: number;
  progressReason?: string | null;
};

export type BackfillJobStatus = "RUNNING" | "LIVE" | "STALLED" | "BLOCKED" | "FAILED" | "STOPPED" | "BACKFILL_PROGRESS_INVALID";

export type BackfillJobSnapshot = {
  jobId: string;
  targetWindow: "12h";
  targetBlockTime: string;
  startedAt: string;
  lastProgressAt: string | null;
  status: BackfillJobStatus;
  targetPoolCount: number;
  completedPoolCount: number;
  oldestCoveredAt: string | null;
  signaturesDiscovered: number;
  transactionsFetched: number;
  transactionsParsed: number;
  transactionsFailed: number;
  unknownInstructions: number;
  requestsLast5m: number;
  successfulTransactionsLast5m: number;
  rpc429Last5m: number;
  currentCursorTime: string | null;
  estimatedFinishAt: string | null;
  etaMs: number | null;
  restartCount: number;
  blockedReason: string | null;
  progressHistory: Array<{ at: string; completedPoolCount: number; oldestCoveredAt: string | null; transactionsFetched?: number }>;
};

export type BackfillPoolCursor = {
  poolAddress: string;
  oldestFetchedSignature: string | null;
  oldestFetchedBlockTime: string | null;
  oldestFetchedSlot: number | null;
  targetBlockTime: string;
  signaturesDiscovered: number;
  transactionsFetched: number;
  transactionsParsed: number;
  transactionsFailed: number;
  unknownInstructions: number;
  lastProgressAt: string | null;
  retryCount: number;
  status: "PENDING" | "RUNNING" | "COMPLETE" | "STALLED" | "BLOCKED" | "FAILED";
};

export type BackfillFailure = {
  jobId: string;
  poolAddress: string;
  signature: string | null;
  method: string;
  error: string;
  retryCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
};

export type EventIndexSnapshot = {
  status: ServiceStatus;
  label: string;
  detail: string;
  sourceUrl: string | null;
  checkedAt: string;
  eventCount: number;
  poolCount: number;
  liveEventCount: number;
  persistedEventCount: number;
  parseLatencyMs: number | null;
  persistenceLatencyMs: number | null;
  backfillProgress: number | null;
  scannedPoolCount: number;
  totalPoolCount: number;
  windows: Record<WindowKey, EventWindowCoverage>;
  poolCoverage: Record<string, Record<WindowKey, EventWindowCoverage>>;
  apiAsOfTime: string | null;
  apiAgeSeconds: number | null;
  crossChecks: {
    fiveMinuteToHour: WindowCrossCheck;
    hourToTwelveHour: WindowCrossCheck;
  };
};

export type MinuteBucket = {
  poolId: string;
  bucketStart: string;
  volumeUsd: number;
  grossFeeUsd: number | null;
  lpFeeUsd: number | null;
  swapCount: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  uniqueWalletCount: number | null;
  tvlStart: number | null;
  tvlEnd: number | null;
  activeTvl: number | null;
  feeDensity: number | null;
  liquidityVelocity: number | null;
  coverageRatio: number | null;
  status: BackfillStatus;
  source: string;
  asOf: string;
};

export type RouteShareMetric = {
  share: number | null;
  pairPoolCount: number;
  windowActivePoolCount: number;
  denominatorVolume: number | null;
  poolVolume: number | null;
  unattributedVolume: number | null;
  source: string;
  observedAt: string | null;
};

export type RangeRecommendation = {
  lowerTick: number;
  upperTick: number;
  lowerPrice: number;
  upperPrice: number;
  lowerPercent: number;
  upperPercent: number;
  candidateCount: number;
  inRangeTimePercent: number | null;
  rebalanceCount24h: number | null;
  method: string;
};

export type QualitySnapshot = {
  score: number | null;
  status: "verified" | "degraded" | "blocked";
  reasons: string[];
  metricScores: Record<string, number | null>;
  details: Record<string, number | string | null>;
  sources: SourceRef[];
};

export type PoolVerification = {
  poolAccountExists: boolean;
  poolOwner: string | null;
  programVerified: boolean;
  mintsVerified: boolean;
  vaultsVerified: boolean;
  active: boolean;
  verifiedAt: string | null;
  slot: number | null;
};

export type PoolIdentity = {
  baseMint: string;
  quoteMint: string;
  poolAddress: string;
  positionNftMint?: string | null;
};

export type FeeReconciliation = {
  status: "PASS" | "FAILED" | "UNAVAILABLE";
  routeASwapLpFeeAtomic: string | null;
  routeBPoolFeeGrowthAtomic: string | null;
  routeBPositionFeeGrowthAtomic: string | null;
  tokenAtomicDifference: string | null;
  usdDifferencePercent: number | null;
  toleranceTokenAtomic: string;
  toleranceUsdPercent: number;
  failureReason: string | null;
  checkedAt: string | null;
};

export type PositionSnapshot = {
  positionNftMint: string;
  owner: string;
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  assetSymbol: string | null;
  poolKind: "CLMM";
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  token0Amount: string | null;
  token1Amount: string | null;
  tokenFeesOwed0: string;
  tokenFeesOwed1: string;
  rewardAmountOwed: string[];
  feeGrowthInsideLast0X64: string;
  feeGrowthInsideLast1X64: string;
  currentTick: number | null;
  inRange: boolean | null;
  positionValueUsd: number | null;
  uncollectedFeeUsd: number | null;
  rewardUsd: number | null;
  activeSeconds: number;
  firstSeenSlot: number | null;
  firstSeenAt: string | null;
  holdBenchmarkValue: number | null;
  impermanentLoss: number | null;
  realizedFeeReturn: number | null;
  actualFeeReturn: number | null;
  inRangeHourlyFeeRate: number | null;
  relativeHoldNetReturn: number | null;
  source: string;
  observedAt: string;
};

export type GroundTruthCalibration = {
  status: "BETA_VALIDATING" | "CALIBRATED" | "BLOCKED";
  modelVersion: string;
  walletAddress: string | null;
  walletConfigured: boolean;
  positionsDiscovered: number;
  snapshotsPersisted: number;
  feeReconciliationsPassed: number;
  feeReconciliationsFailed: number;
  windowCoveragePassed: boolean;
  rankingRegressionPassed: boolean;
  regressionCases: CalibrationRegressionCase[];
  blockers: string[];
  lastCheckedAt: string;
};

export type RankingMode =
  | "executableNet"
  | "executableFee"
  | "lpFee"
  | "volume"
  | "lpFeeDensity"
  | "lpFee1h"
  | "lpFee6h"
  | "lpFee12h"
  | "officialFee24h"
  | "feeDensity"
  | "routeShare"
  | "acceleration"
  | "capitalUtilization"
  | "activity"
  | "officialApr"
  | "officialVolume"
  | "officialFee"
  | "predictedFee"
  | "predictedNet"
  | "actualPositionReturn"
  | "riskAdjustedNet";

export const CAPITAL_OPTIONS = [1_000, 10_000] as const;
export type CapitalOption = (typeof CAPITAL_OPTIONS)[number];
export type CapacityStatus = "充足" | "偏小" | "过小" | "禁止" | "等待数据";
export type RecommendationVerdict = "推荐" | "观察" | "放弃";

export type ExecutableEstimate = {
  capitalUsd: number;
  window: WindowKey;
  activeTvlUsd: number | null;
  postDepositTvlUsd?: number | null;
  capitalToActiveTvlRatio: number | null;
  userLiquidityShare: number | null;
  earningsDilution: number | null;
  inRangeProbability: number | null;
  dataQualityFactor?: number | null;
  estimateMethod?: "TICK_LEVEL" | "TVL_CONSERVATIVE" | "OFFICIAL_24H" | null;
  expectedLpFeeUsd: number | null;
  entrySlippageUsd: number | null;
  tradingFeeUsd: number | null;
  priorityFeeUsd: number | null;
  exitCostUsd: number | null;
  rebalanceCostUsd: number | null;
  impermanentLossUsd: number | null;
  opportunityCostUsd: number | null;
  netProfitUsd: number | null;
  netReturnPct: number | null;
  missingModelInputs?: string[];
  recommendedMaxCapitalUsd: number | null;
  capacityStatus: CapacityStatus;
  risk: "低" | "中" | "高" | "不可用";
  status: "READY" | "FEE_UNAVAILABLE" | "NET_MODEL_UNAVAILABLE" | "CAPACITY_BLOCKED";
  reason: string;
  formulaVersion: string;
};

export type PoolRecommendation = {
  verdict: RecommendationVerdict;
  reason: string;
  capitalUsd: number;
  window: WindowKey;
};

export type DecisionHorizon = "1h" | "6h" | "12h" | "24h";
export type DecisionStatus = "READY" | "WAITING_DATA" | "CAPACITY_BLOCKED";
export type DecisionAction = "BUY" | "WAIT" | "AVOID";
export type DecisionRankingBasis = "NET_PROFIT" | "LP_FEE" | "CAPACITY_ONLY";

export type YieldPrediction = {
  horizon: DecisionHorizon;
  expectedPoolFeeUsd: number | null;
  expectedLpFeeUsd: number | null;
  expectedNetProfitUsd: number | null;
  netReturnPct: number | null;
  trendPct: number | null;
  confidence: number | null;
  status: "READY" | "WAITING_DATA";
  sourceWindow: WindowKey | null;
  reason: string;
};

export type ExplainReason = {
  direction: "positive" | "negative";
  label: string;
  value: string;
  detail: string;
  weight: number;
};

export type MigrationDecision = {
  status: "READY" | "WAITING_DATA" | "NOT_APPLICABLE";
  action: "MIGRATE" | "HOLD" | "WAIT";
  score: number | null;
  fromPoolAddress: string | null;
  toPoolAddress: string | null;
  expectedAdditionalNetUsd: number | null;
  expectedAdditionalFeeUsd: number | null;
  migrationCostUsd: number | null;
  paybackHours: number | null;
  reason: string;
};

export type PoolDecision = {
  capitalUsd: number;
  status: DecisionStatus;
  action: DecisionAction;
  recommended: boolean;
  starRating: number | null;
  score: number | null;
  rankingBasis: DecisionRankingBasis;
  confidence: number | null;
  risk: "Low" | "Medium" | "High" | "Unavailable";
  selectedHorizon: DecisionHorizon;
  predictions: Record<DecisionHorizon, YieldPrediction>;
  reasons: ExplainReason[];
  migration: MigrationDecision | null;
  modelVersion: string;
};

export type RankingSummary = {
  defaultMode: RankingMode;
  requestedDefaultMode?: RankingMode;
  available: Record<RankingMode, boolean>;
  blockers: string[];
  modelVersion: string;
  capitalOptions?: CapitalOption[];
};

export type PublicMarketLevel = "LEVEL_1_API" | "LEVEL_2_RPC" | "LEVEL_3_REALTIME";

export type PublicMarketHealth = {
  mode: "PUBLIC_MARKET";
  status: "PUBLIC_RWA_MARKET_READY" | "PUBLIC_RWA_MARKET_DEGRADED" | "PUBLIC_RWA_MARKET_UNAVAILABLE";
  level: PublicMarketLevel;
  label: string;
  detail: string;
  apiAvailable: boolean;
  assetCount: number | null;
  pairCount: number;
  poolCount: number;
  source: string;
  updatedAt: string | null;
  apiLatencyMs: number | null;
};

export type ProductStatusReport = {
  PUBLIC_MARKET_STATUS: string;
  SHORT_WINDOW_ANALYTICS_STATUS: string;
  RPC_VERIFICATION_STATUS: string;
  REALTIME_INDEXING_STATUS: string;
  WALLET_POSITION_STATUS: string;
  NET_YIELD_STATUS: string;
};

export type IndexerStatusReport = {
  PUBLIC_MARKET_DATA: string;
  REALTIME_STREAM: string;
  HISTORICAL_BACKFILL_1H: string;
  HISTORICAL_BACKFILL_6H: string;
  HISTORICAL_BACKFILL_12H: string;
  HISTORICAL_BACKFILL_24H: string;
  FEE_PARSER: string;
  ROUTE_SHARE: string;
  OFFICIAL_RECONCILIATION: string;
  NET_YIELD_MODEL: string;
  WALLET_POSITIONS: string;
};

export type OfficialReconciliationSnapshot = {
  status: "READY" | "PARTIAL" | "FAILED" | "UNAVAILABLE";
  officialAsOf: string | null;
  localAsOf: string | null;
  poolCount: number;
  comparedPoolCount: number;
  volumeDifferencePct: number | null;
  feeDifferencePct: number | null;
  failedPoolCount: number;
  lastRunAt: string | null;
  detail: string;
};

export type PersistedPoolMetricState = {
  windows: Record<WindowKey, WindowMetric>;
  routeShareByWindow: Record<WindowKey, RouteShareMetric>;
  feeDensity: number | null;
  velocity: number | null;
  effectiveActiveTvl: number | null;
  recentSwaps: SwapEventRecord[];
  updatedAt: string;
};

export type PublicMetricsState = {
  generatedAt: string;
  source: "indexer-worker" | "request-fallback";
  pools: Record<string, PersistedPoolMetricState>;
  windows: Record<WindowKey, EventWindowCoverage>;
  status: IndexerStatusReport;
  detail: string;
};

export type CalibrationRegressionCase = {
  label: string;
  targetBaseMint: string;
  quoteMint: string;
  feeTier: string;
  poolAddress: string | null;
  positionNftMint: string | null;
  status: "PASS" | "FAIL" | "BLOCKED";
  metrics: Record<string, number | string | boolean | null>;
  variants: Record<string, {
    formula: string;
    rank: number | null;
    score: number | null;
    status: "OBSERVED" | "BLOCKED";
  }>;
  blockers: string[];
  explanation: string;
};

export type PoolSnapshot = {
  id: string;
  pair: string;
  pairKey: string;
  identity: PoolIdentity;
  asset: {
    symbol: string;
    name: string;
    mint: string;
    decimals: number | null;
  };
  issuer: string | null;
  quote: {
    symbol: "USDC";
    mint: string;
    decimals: number | null;
  };
  protocol: "raydium";
  kind: PoolKind;
  programId: string;
  feeRate: number | null;
  feeTier: string | null;
  dynamicFee: boolean | null;
  configId: string | null;
  tickSpacing: number | null;
  currentTick: number | null;
  sqrtPrice: number | null;
  currentPrice: number | null;
  price24hLow: number | null;
  price24hHigh: number | null;
  liquidity: number | null;
  activeLiquidity: number | null;
  activeLiquidityRatio: number | null;
  tvl: number | null;
  effectiveActiveTvl: number | null;
  vaults: {
    a: string | null;
    b: string | null;
  };
  windows: Record<WindowKey, WindowMetric>;
  volume24h: number | null;
  fee24h: number | null;
  predictedFee24h: number | null;
  feeApr: number | null;
  apr: number | null;
  apy: number | null;
  routeShare: number | null;
  routeShareByWindow: Record<WindowKey, RouteShareMetric>;
  feeDensity: number | null;
  velocity: number | null;
  grossYieldApr: number | null;
  expectedNetYield: number | null;
  executableEstimates: Record<string, Record<WindowKey, ExecutableEstimate>>;
  recommendations: Record<string, PoolRecommendation>;
  decisions?: Record<string, PoolDecision>;
  rangeOptions: string[];
  recommendedRange: string | null;
  rangeRecommendation: RangeRecommendation | null;
  feeReconciliation: FeeReconciliation;
  marketLevel: PublicMarketLevel;
  verificationStatus: "已核验" | "待核验" | "不可用";
  windowCoverage: Record<WindowKey, EventWindowCoverage>;
  confidence: number | null;
  quality: QualitySnapshot;
  verification: PoolVerification;
  sources: SourceRef[];
  dataAt: string;
  recentSwaps?: SwapEventRecord[];
};

export type SessionState =
  | "周末"
  | "假日休市"
  | "盘前"
  | "盘中"
  | "盘后"
  | "隔夜休市"
  | "提前收市";

export type MarketSession = {
  state: SessionState;
  nyTime: string;
  beijingTime: string;
  nextOpen: string | null;
  minutesToNextOpen: number | null;
  isTradingDay: boolean;
  confidenceAdjustment: number;
  chainActivity: "正常" | "低活跃" | "等待参考价格样本";
  referenceAgeSeconds: number | null;
  holidayName: string | null;
};

export type ServiceStatus = "在线" | "降级" | "离线" | "未配置";

export type ServiceHealth = {
  name: string;
  label: string;
  status: ServiceStatus;
  latencyMs: number | null;
  detail: string;
  sourceUrl: string | null;
  checkedAt: string;
};

export type RpcPoolSnapshot = {
  activeProvider: string | null;
  currentSlot: number | null;
  finalizedSlot: number | null;
  slotLag: number | null;
  providers: ServiceHealth[];
};

export type LastSwap = {
  signature: string;
  poolId: string;
  slot: number;
  blockTime: string | null;
  sourceUrl: string;
  parsedAt: string | null;
  parseLatencyMs: number | null;
  persistenceLatencyMs: number | null;
  persisted: boolean;
  eventWindow: WindowKey | null;
};

export type AssetCoverageSummary = {
  candidateRwaAssetCount: number | null;
  identityVerifiedAssetCount: number | null;
  stockMappedAssetCount: number | null;
  etfMappedAssetCount: number | null;
  withUsdcPoolAssetCount: number | null;
  currentlyTradableAssetCount: number | null;
  with24hVolumeAssetCount: number | null;
  withMinuteSwapAssetCount: number | null;
  classificationSource: string;
};

export type DiscoverySummary = {
  rwaAssetCount: number | null;
  candidatePoolCount: number;
  pairCount: number;
  verifiedPoolCount: number;
  apiStatus: ServiceStatus;
  apiUrl: string;
  officialPageUrl: string;
  discoveredAt: string;
  apiObservedAt: string | null;
  errors: string[];
  assetCoverage: AssetCoverageSummary;
};

export type DashboardSnapshot = {
  status: "LIVE_RWA_DATA_BETA_VALIDATING" | "LIVE_RWA_DATA_FULLY_CONNECTED" | "LIVE_RWA_DATA_PARTIAL" | "NO_TRUSTED_DATA";
  generatedAt: string;
  network: "Solana Mainnet";
  pools: PoolSnapshot[];
  pairs: string[];
  discovery: DiscoverySummary;
  session: MarketSession;
  rpc: RpcPoolSnapshot;
  websocket: ServiceHealth;
  raydiumApi: ServiceHealth;
  swapIndexer: EventIndexSnapshot;
  dataQuality: QualitySnapshot;
  lastSwap: LastSwap | null;
  positions: PositionSnapshot[];
  calibration: GroundTruthCalibration;
  ranking: RankingSummary;
  publicMarket: PublicMarketHealth;
  statusReport: ProductStatusReport;
  indexerStatus: IndexerStatusReport;
  officialReconciliation: OfficialReconciliationSnapshot;
  wallet: {
    configured: boolean;
    address: string | null;
    readOnly: true;
  };
  alerts: string[];
  snapshotSource?: "LIVE" | "LAST_KNOWN_GOOD";
  lastKnownGoodAt?: string | null;
  localAccess?: {
    localUrl: string;
    lanUrl: string | null;
    lanIp: string | null;
  };
};

export type Decision = {
  poolId: string;
  pair: string;
  feeTier: string | null;
  range: string | null;
  positionSize: number;
  expectedNetYield: number;
  confidence: number;
  rationale: string[];
};

export type ConnectorHealth = {
  connector: string;
  status: "online" | "degraded" | "offline";
  latencyMs: number | null;
  dataQuality: number | null;
  lastBlock: number | null;
};
