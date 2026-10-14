# Echo

Returns the submitted `message` in an `echo_result` JSON artifact.

- Input: `message`, required string, 1–500 Unicode code points.
- Price: 10,000 atomic USDC units (0.01 USDC).
- Fulfillment: automated, synchronous, one-shot.
- Result: terminal `completed` or `failed`; no polling or follow-up input.
- Artifact: the complete completed result, exactly
  `{"status": "completed", "message": "Echo completed.", "artifacts":
  [{"name": "echo_result", "mimeType": "application/json", "data":
  {"message": "<trimmed message>"}}]}`.
- Failure: a reviewed code only (`invalid_input`, `unknown_skill`, or one of
  core's generic codes); failure evidence carries no message.
- Declined before payment: a message that is empty once trimmed, or one the
  gateway would refuse to relay (markup tags, script URLs, event-handler
  attributes, control characters).

This is a protocol example, not a real marketplace product, and cannot run on
Base mainnet.
