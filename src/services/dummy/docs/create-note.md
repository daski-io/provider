# create-note

Paid demonstration skill ($0.10 USDC): validates a short note and provisions
a non-sensitive **asset** owned by the wallet-authorized payer. Request a quote
through the Daski gateway before payment; internally, the gateway calls the
provider's `POST /standard-rail/quote` endpoint. Validation errors are free
to fix before any payment challenge is issued.

## Required fields

| Field | Type | Constraints |
| --- | --- | --- |
| `title` | string | 1–80 characters; at least one letter or digit |

## Optional fields

| Field | Type | Constraints |
| --- | --- | --- |
| `body` | string | up to 2,000 characters |

The dummy validates the body and reports its character count, but does not
retain the body in asset metadata. It retains the title and character count
only. Do not submit credentials, personal data, or other sensitive content.

## Asset identity

The asset identifier is the kebab-case canonicalization of `title`
(`"Launch Checklist!"` → `launch-checklist`). Creating a second note whose
title canonicalizes to a live identifier fails.

## Output

Artifact `note_created`:

```json
{ "note": "launch-checklist", "title": "Launch Checklist!", "characters": 42 }
```

The asset appears with `assetType: "note"`, `status: "active"`.
