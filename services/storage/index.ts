export type StorageLayout = {
  sqlite: "配置、只读地址、推荐版本、告警状态";
  duckdb: "窗口指标、回测、特征查询";
  parquet: "Swap、流动性、Tick、仓位历史归档";
};

export const storageLayout: StorageLayout = {
  sqlite: "配置、只读地址、推荐版本、告警状态",
  duckdb: "窗口指标、回测、特征查询",
  parquet: "Swap、流动性、Tick、仓位历史归档",
};

export type RecommendationSnapshot = {
  version: string;
  parameters: Record<string, string | number | boolean | null>;
  inputsObservedAt: string;
  recommendation: Record<string, string | number | null>;
};
