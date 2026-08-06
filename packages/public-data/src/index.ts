export type PublicDataSource = "raydium-api-v3" | "market-calendar" | "reference-price";

export type PublicDataEnvelope<T> = {
  source: PublicDataSource;
  sourceTimestamp: string;
  receivedAt: string;
  value: T;
};

export type PublicDataAdapter<T> = {
  name: PublicDataSource;
  fetch: () => Promise<PublicDataEnvelope<T>>;
};

