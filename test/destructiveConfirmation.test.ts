import { describe, expect, it } from "vitest";
import { renderConfirmationSummary } from "../src/core/standardRail/destructiveAction.js";

describe("destructive action confirmation summaries", () => {
  it("binds matching fields from the exact request and preserves reviewed constants", () => {
    expect(renderConfirmationSummary({
      actionId: "placeholder",
      providerAssetId: "placeholder",
      reason: "permanent deletion",
      acknowledgment: false,
    }, {
      actionId: "delete-item",
      providerAssetId: "item-123",
      input: { acknowledgment: true, ignored: "not in the summary template" },
    })).toEqual({
      actionId: "delete-item",
      providerAssetId: "item-123",
      reason: "permanent deletion",
      acknowledgment: true,
    });
  });
});
