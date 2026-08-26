# Echo

Returns the submitted `message` in an `echo_result` JSON artifact.

- Input: `message`, required string, 1–500 Unicode code points.
- Price: 10,000 atomic USDC units (0.01 USDC).
- Fulfillment: automated, synchronous, one-shot.
- Result: terminal `completed` or `failed`; no polling or follow-up input.

This is a protocol example, not a real marketplace product, and cannot run on
Base mainnet.
