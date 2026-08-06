export type SubscriptionTier = 1 | 2 | 3;

export type SubscriptionPolicy = {
  tier: SubscriptionTier;
  alwaysOn: boolean;
  detailOnDemand: boolean;
  downgradeDelayMs: number;
};

export const subscriptionPolicies: SubscriptionPolicy[] = [
  { tier: 1, alwaysOn: true, detailOnDemand: false, downgradeDelayMs: 0 },
  { tier: 2, alwaysOn: false, detailOnDemand: true, downgradeDelayMs: 5 * 60_000 },
  { tier: 3, alwaysOn: false, detailOnDemand: false, downgradeDelayMs: 5 * 60_000 },
];

