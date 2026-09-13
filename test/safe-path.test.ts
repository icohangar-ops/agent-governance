import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AuditLedger,
  ChpGate,
  PathEscapeError,
  confinePath,
  createPolicy,
  loadPolicy,
  verifyLedger,
} from "../src/index.js";

const KEY = "test-key-0123456789";
const ESCAPE = "../outside-agent-governance.jsonl";

describe("confinePath", () => {
  test("resolves a relative in-tree path under cwd", () => {
    const confined = confinePath(join("var", "audit.jsonl"));
    assert.equal(confined, resolve(process.cwd(), "var", "audit.jsonl"));
  });

  test("allows a path under the OS temp directory", () => {
    const input = join(tmpdir(), "audit-ledger-safe", "audit.jsonl");
    assert.equal(confinePath(input), resolve(input));
  });

  test("allows .. that stays inside an allowed base", () => {
    const input = join(tmpdir(), "nested", "..", "stays.jsonl");
    assert.equal(confinePath(input), resolve(tmpdir(), "stays.jsonl"));
  });

  test("rejects relative traversal out of cwd", () => {
    assert.throws(() => confinePath(ESCAPE), PathEscapeError);
    assert.throws(() => confinePath("../../etc/passwd"), PathEscapeError);
  });

  test("rejects an empty path", () => {
    assert.throws(() => confinePath(""), PathEscapeError);
    assert.throws(() => confinePath("   "), PathEscapeError);
  });

  test("rejects an absolute path outside cwd and tmp", () => {
    assert.throws(() => confinePath("/etc/passwd"), PathEscapeError);
  });
});

describe("AuditLedger path confinement", () => {
  test("rejects a traversing ledger path at construct and verify", () => {
    assert.throws(() => new AuditLedger({ path: ESCAPE, key: KEY }), PathEscapeError);
    assert.throws(() => verifyLedger(ESCAPE, KEY), PathEscapeError);
  });

  test("keeps append + verify for a relative in-tree path", () => {
    const rel = join("var", `audit-confine-${process.pid}.jsonl`);
    try {
      const ledger = new AuditLedger({ path: rel, key: KEY, lock: false });
      ledger.append({ event: "e0", actor: "a" });
      const result = verifyLedger(rel, KEY);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.count, 1);
    } finally {
      rmSync(rel, { force: true });
    }
  });
});

describe("loadPolicy path confinement", () => {
  test("rejects a traversing policy path even in non-strict mode", () => {
    assert.throws(() => loadPolicy(ESCAPE, { warn: () => {} }), PathEscapeError);
    assert.throws(() => loadPolicy("../../etc/passwd", { strict: true }), PathEscapeError);
  });

  test("loads a relative in-tree YAML path", () => {
    const rel = join("config", `policy-confine-${process.pid}.yaml`);
    mkdirSync("config", { recursive: true });
    try {
      writeFileSync(rel, 'version: "1.0"\nmax_notional_usd: 42\nallowed_actions:\n  - buy\n');
      const policy = loadPolicy(rel, { strict: true });
      assert.equal(policy.maxNotionalUsd, 42);
    } finally {
      rmSync(rel, { force: true });
    }
  });
});

describe("ChpGate path confinement", () => {
  test("rejects a traversing statePath", () => {
    assert.throws(
      () => new ChpGate({ policy: createPolicy(), statePath: ESCAPE }),
      PathEscapeError,
    );
  });

  test("rejects a traversing policyPath", () => {
    assert.throws(() => new ChpGate({ policyPath: ESCAPE }), PathEscapeError);
  });
});
