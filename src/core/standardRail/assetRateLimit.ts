import type { Address } from "viem";
import type { Queryable } from "../db/queryable.js";
import { canonicalHash } from "./canonical.js";
import type { ProviderWalletConfig } from "./walletConfig.js";

const bytes = (value: `0x${string}`): Buffer => Buffer.from(value.slice(2), "hex");

export async function consumeAssetEndpointRate(args: {
  db: Queryable;
  gatewaySigner: Address;
  payer: Address;
  actionId: string;
  limits: ProviderWalletConfig["abuse"];
}): Promise<void> {
  const buckets = [
    {
      scope: "gateway-signer",
      key: args.gatewaySigner.toLowerCase(),
      maximum: args.limits.requestsPerGatewaySignerPerMinute,
    },
    {
      scope: "payer",
      key: args.payer.toLowerCase(),
      maximum: args.limits.requestsPerPayerPerMinute,
    },
    {
      scope: "provider-action",
      key: args.actionId,
      maximum: args.limits.requestsPerActionPerMinute,
    },
    { scope: "global", key: "provider-asset-endpoints", maximum: args.limits.requestsGlobalPerMinute },
  ];
  for (const bucket of buckets) {
    const keyHash = canonicalHash({ scope: bucket.scope, key: bucket.key });
    const result = await args.db.query<{ request_count: number }>(
      `INSERT INTO standard_asset_rate_buckets(scope,key_hash,window_started_at,request_count)
       VALUES ($1,$2,now(),1)
       ON CONFLICT (scope,key_hash) DO UPDATE SET
         window_started_at=CASE
           WHEN standard_asset_rate_buckets.window_started_at<=now()-interval '1 minute'
             THEN now() ELSE standard_asset_rate_buckets.window_started_at END,
         request_count=CASE
           WHEN standard_asset_rate_buckets.window_started_at<=now()-interval '1 minute'
             THEN 1 ELSE standard_asset_rate_buckets.request_count+1 END
       RETURNING request_count`,
      [bucket.scope, bytes(keyHash)],
    );
    if ((result.rows[0]?.request_count ?? bucket.maximum + 1) > bucket.maximum) {
      throw new Error("provider asset rate limit exceeded");
    }
  }
}
