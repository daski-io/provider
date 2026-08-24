import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { Hex } from "viem";
import { admitStandardEvidence } from "../src/core/standardRail/evidenceAdmissions.js";
import type { StandardEvidenceBundleV2 } from "../src/core/standardRail/types.js";

const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;

function bundle(): StandardEvidenceBundleV2 {
  return {
    deposit: {
      transactionHash: hash("1"),
      blockNumber: "100",
      blockHash: hash("2"),
      transactionIndex: 3,
      logIndex: 4,
      evidenceHash: hash("3"),
      canonicalEvidence: { kind: "deposit" },
      sources: ["rpc.example"],
    },
    release: {
      transactionHash: hash("4"),
      blockNumber: "101",
      blockHash: hash("5"),
      transactionIndex: 6,
      logIndex: 7,
      releaseSequence: "9",
      evidenceHash: hash("6"),
      canonicalEvidence: { kind: "release" },
      sources: ["rpc.example"],
    },
  };
}

describe("standard evidence admissions V2", () => {
  it("persists release sequence only for release evidence", async () => {
    const inserts: unknown[][] = [];
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("INSERT INTO standard_evidence_admissions")) {
        inserts.push(values ?? []);
        return { rowCount: 1 };
      }
      return { rowCount: null };
    });
    const client = {
      query,
      release: vi.fn(),
    } as unknown as PoolClient;

    await admitStandardEvidence(
      "ord_00000000-0000-4000-8000-000000000000",
      bundle(),
      hash("7"),
      { connect: async () => client },
    );

    expect(inserts).toHaveLength(2);
    expect(inserts[0]![2]).toBe("deposit");
    expect(inserts[0]![7]).toBeNull();
    expect(inserts[1]![2]).toBe("release");
    expect(inserts[1]![7]).toBe("9");
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
