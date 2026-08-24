import { describe, expect, it } from "vitest";
import {
  assertDatabaseRolePosture,
  type DatabaseRolePosture,
} from "../src/core/db/pool.js";

const runtime: DatabaseRolePosture = {
  current_user: "daski_runtime",
  can_create: false,
  can_create_database: false,
  can_temporary: false,
  superuser: false,
  create_db: false,
  create_role: false,
  bypass_rls: false,
  member_of_any_role: false,
  owns_schema: false,
  owned_tables: 0,
};
const migration: DatabaseRolePosture = {
  ...runtime,
  current_user: "daski_migration",
  can_create: true,
  owns_schema: true,
  owned_tables: 42,
};

describe("database role security", () => {
  it("accepts a distinct least-privilege runtime and migration owner", () => {
    expect(() => assertDatabaseRolePosture(runtime, migration)).not.toThrow();
  });

  for (const privilege of ["superuser", "create_db", "create_role", "bypass_rls"] as const) {
    it(`rejects runtime ${privilege}`, () => {
      expect(() => assertDatabaseRolePosture({ ...runtime, [privilege]: true }, migration)).toThrow();
    });
  }

  it("rejects runtime relation ownership", () => {
    expect(() => assertDatabaseRolePosture({ ...runtime, owned_tables: 1 }, migration)).toThrow();
  });

  it("rejects runtime membership in another database role", () => {
    expect(() => assertDatabaseRolePosture(
      { ...runtime, member_of_any_role: true },
      migration,
    )).toThrow(/inherit authority/);
  });

  it("rejects runtime database creation and temporary-relation authority", () => {
    expect(() => assertDatabaseRolePosture(
      { ...runtime, can_create_database: true },
      migration,
    )).toThrow(/temporary relations/);
    expect(() => assertDatabaseRolePosture(
      { ...runtime, can_temporary: true },
      migration,
    )).toThrow(/temporary relations/);
  });
});
