export type AssetActionReplayPolicy =
  | "stable-result"
  | "regenerate-ephemeral"
  | "redacted-after-window";

export interface ProviderOutcomeLaunchPolicy {
  outcomeIds: readonly string[];
}

export interface ProviderAssetActionLaunchPolicy {
  actionId: string;
  destructive: boolean;
  replayPolicy: AssetActionReplayPolicy;
}

export interface ProviderWalletLaunchPolicy {
  assetActions: readonly ProviderAssetActionLaunchPolicy[];
}

export type ProviderLaunchPolicy =
  ProviderOutcomeLaunchPolicy & ProviderWalletLaunchPolicy;
