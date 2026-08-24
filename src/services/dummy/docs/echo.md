# echo

Free connectivity check: returns your message back as an artifact,
completing immediately. Direct open calls require no payment, ownership, or
wallet authorization. Gateway-mediated calls still use the normal signed
provider request flow.

## Required fields

| Field | Type | Constraints |
| --- | --- | --- |
| `message` | string | 1–500 characters |

## Output

Artifact `echo_result`:

```json
{ "message": "<your message>", "processedAt": "<ISO timestamp>" }
```

## Errors

Missing or over-length `message` fails the task with a field-level error
(also surfaced for free during quote validation).
