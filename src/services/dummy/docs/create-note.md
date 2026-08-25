# create-note

Paid demonstration skill ($0.10 USDC): validates a short note and provisions
a non-sensitive **asset** owned by the wallet-authorized payer. Request a quote
through the Daski gateway before payment; internally, the gateway calls the
provider's `POST /standard-rail/quote` endpoint. Validation errors are free
to fix before any payment challenge is issued.

## Required fields

| Field | Type | Constraints |
| --- | --- | --- |
| `title` | string | 1–80 Unicode code points; at least one ASCII letter or digit |

## Optional fields

| Field | Type | Constraints |
| --- | --- | --- |
| `body` | string | up to 2,000 Unicode code points |

## Example request

```json
{
  "title": "Launch Checklist!",
  "body": "hello world"
}
```

The dummy validates the body and reports its Unicode code-point count, but does
not retain the body in asset metadata. It retains the title and count only. Do
not submit credentials, personal data, or other sensitive content.

## Asset identity

The asset identifier combines the kebab-case title prefix with the unique task
id. For example, `"Launch Checklist!"` becomes
`launch-checklist-00000000-0000-4000-8000-000000000001`. Repeating a title
creates a separate asset instead of failing after payment.

## Output

Artifact `note_created`:

```json
{
  "note": "launch-checklist-00000000-0000-4000-8000-000000000001",
  "title": "Launch Checklist!",
  "characters": 11
}
```

The asset appears with `assetType: "note"`, `status: "active"`.
