import { describe, expect, it } from "vitest";
import {
  assessPostmarkInboundSecurity,
  type PostmarkHeader,
} from "../src/core/email/postmarkInboundSecurity.js";

function header(Name: string, Value: string): PostmarkHeader {
  return { Name, Value };
}

const passingHeaders = [
  header("Received-SPF", "pass (sender SPF authorized)"),
  header(
    "X-Spam-Tests",
    "DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS",
  ),
  header("X-Spam-Status", "No"),
  header("X-Spam-Score", "-0.1"),
];

describe("Postmark inbound security verdicts", () => {
  it("accepts complete Postmark SPF, aligned-DKIM, and non-spam verdicts", () => {
    expect(assessPostmarkInboundSecurity(passingHeaders)).toEqual({
      senderAuthenticated: true,
      spamSafe: true,
    });
  });

  it("ignores a message-supplied Authentication-Results claim", () => {
    expect(assessPostmarkInboundSecurity([
      header(
        "Authentication-Results",
        "attacker.example; spf=pass; dkim=pass; dmarc=pass",
      ),
    ])).toEqual({
      senderAuthenticated: false,
      spamSafe: false,
    });
  });

  it("fails closed on duplicate or incomplete Postmark verdict headers", () => {
    const duplicate = assessPostmarkInboundSecurity([
      ...passingHeaders,
      header("received-spf", "fail (forged duplicate)"),
      header("X-Spam-Status", "Yes"),
    ]);
    expect(duplicate).toEqual({
      senderAuthenticated: false,
      spamSafe: false,
    });

    const highScore = assessPostmarkInboundSecurity([
      ...passingHeaders.filter((item) => item.Name !== "X-Spam-Score"),
      header("X-Spam-Score", "5"),
    ]);
    expect(highScore.spamSafe).toBe(false);

    const missingAlignedDkim = assessPostmarkInboundSecurity([
      ...passingHeaders.filter((item) => item.Name !== "X-Spam-Tests"),
      header("X-Spam-Tests", "DKIM_SIGNED,DKIM_VALID,SPF_PASS"),
    ]);
    expect(missingAlignedDkim).toEqual({
      senderAuthenticated: false,
      spamSafe: true,
    });
  });
});
