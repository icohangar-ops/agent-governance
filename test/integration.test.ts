import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChpGate, AuditLedger, verifyLedger, createPolicy, type AuditRecord } from "../src/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gov-integration-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "integration-key";

function policy() {
  return createPolicy({
    version: "int-test",
    maxNotionalUsd: 1000,
    dailyNotionalCapUsd: 2000,
    hitlThresholdUsd: 500,
    allowedActions: ["buy", "sell"],
    minConfidence: 0.5,
  });
}

describe("gate -> signed ledger integration", () => {
  test("every decision is auto-appended and the ledger verifies", () => {
    const ledgerPath = join(dir, "audit.jsonl");
    const ledger = new AuditLedger({ path: ledgerPath, key: KEY });
    const gate = new ChpGate({ policy: policy(), ledger, actor: "trader-bot" });

    const locked = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 100, confidence: 0.9 });
    const hitl = gate.evaluate({ action: "sell", asset: "ETH", notionalUsd: 700 });
    const blocked = gate.evaluate({ action: "short", asset: "ETH", notionalUsd: 100 });
    gate.approveHuman(hitl.provenance.decisionId, "sam");

    const result = verifyLedger(ledgerPath, KEY);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 4);

    const records = readFileSync(ledgerPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as AuditRecord);

    assert.deepEqual(
      records.map((r) => r.event),
      ["chp.locked", "chp.hitl_required", "chp.blocked", "chp.locked"],
    );
    assert.ok(records.every((r) => r.actor === "trader-bot"));
    assert.ok(records.every((r) => (r.sources as string[])[0] === "policy:int-test"));

    // Ledger inputs carry full decision provenance.
    const first = records[0]!.inputs as { decisionId: string; contentHash: string; claims: unknown[] };
    assert.equal(first.decisionId, locked.provenance.decisionId);
    assert.equal(first.contentHash, locked.provenance.contentHash);
    assert.ok(Array.isArray(first.claims) && first.claims.length > 0);

    const blockedRec = records[2]!.inputs as { decisionId: string };
    assert.equal(blockedRec.decisionId, blocked.provenance.decisionId);
  });

  test("two gates (simulating two processes) share one ledger without forking the chain", () => {
    const ledgerPath = join(dir, "audit.jsonl");
    const gateA = new ChpGate({
      policy: policy(),
      ledger: new AuditLedger({ path: ledgerPath, key: KEY }),
      actor: "proc-a",
    });
    const gateB = new ChpGate({
      policy: policy(),
      ledger: new AuditLedger({ path: ledgerPath, key: KEY }),
      actor: "proc-b",
    });

    for (let i = 0; i < 3; i++) {
      gateA.evaluate({ action: "buy", asset: "ETH", notionalUsd: 10 });
      gateB.evaluate({ action: "sell", asset: "ETH", notionalUsd: 10 });
    }

    const result = verifyLedger(ledgerPath, KEY);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 6);
  });

  test("public API surface is exported from the package index", async () => {
    const api = await import("../src/index.js");
    for (const name of [
      "ChpGate",
      "AuditLedger",
      "verifyLedger",
      "canonicalJson",
      "createPolicy",
      "validatePolicy",
      "loadPolicy",
      "defaultPolicy",
      "defaultPolicyPath",
      "parseFlatYaml",
      "PolicyValidationError",
      "LedgerLockError",
      "DEFAULT_AUDIT_LEDGER_KEY",
      "AUDIT_LEDGER_KEY_ENV",
    ]) {
      assert.ok(name in api, `missing export: ${name}`);
    }
  });
});
