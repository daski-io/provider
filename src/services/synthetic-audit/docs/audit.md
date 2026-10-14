# Audit

Audits the subject in `description` and returns a short report.

- Input: `description`, required string, 1–2,000 Unicode code points of
  plain text.
- Price: 500,000 atomic USDC units (0.50 USDC).
- Fulfillment: automated external job; the product's audit runs about eight
  hours under a declared 12-hour fulfillment window.
- States: `submitted` until the job starts, then `working` until the report
  is ready; no follow-up input, cancellation or support.
- Artifact: the complete completed result, `{"status": "completed",
  "message": "Synthetic audit completed.", "artifacts": [{"name":
  "audit_report", "mimeType": "application/json", "data": {"summary",
  "findings": [{"severity", "title"}]}}]}`.
- Failure: a reviewed code only (`audit_rejected`, `invalid_input`,
  `unknown_skill`, or one of core's codes); failure evidence carries no
  message.
- Declined before payment: a description that is empty once trimmed, too
  long, or not plain text.

This is a protocol example around a fake product, not a marketplace offer,
and cannot run on Base mainnet.
