import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChpGate, type ChpDecision } from "../src/gate.js";
import { createPolicy } from "../src/policy.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chp-gate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function basePolicy() {
  return createPolicy({
    version: "test",
    maxNotionalUsd: 1000,
    dailyNotionalCapUsd: 2000,
    hitlThresholdUsd: 500,
    allowedActions: ["buy", "sell"],
    perAssetLimits: { CAKE: 100 },
    minConfidence: 0.5,
    allowedAssets: ["ETH", "CAKE", "SOL"],
    blockedAssets: ["SHIB"],
    allowedVenues: ["hyperliquid"],
    maxLeverage: 5,
    priceBand: { min: 0.02, max: 0.98 },
  });
}

describe("ChpGate evaluate — LOCKED path", () => {
  test("locks an in-policy action and counts the daily cap", () => {
    const gate = new ChpGate({ policy: basePolicy() });
    const d = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 100, confidence: 0.9 });
    assert.equal(d.state, "LOCKED");
    assert.equal(d.allowed, true);
    assert.equal(d.requiresHuman, false);
    assert.ok(d.provenance.decisionId);
    assert.ok(d.provenance.contentHash.match(/^[0-9a-f]{64}$/));
    assert.ok(d.provenance.claims.every((c) => c.passed));
    assert.equal(gate.getDailyNotionalUsd(), 100);
    assert.equal(gate.getDecisions().length, 1);
  });
});

describe("ChpGate evaluate — BLOCKED paths", () => {
  const cases: { name: string; action: Parameters<ChpGate["evaluate"]>[0]; rule: string }[] = [
    { name: "disallowed action", action: { action: "short", asset: "ETH", notionalUsd: 10 }, rule: "allowed-action" },
    { name: "asset not on allowlist", action: { action: "buy", asset: "DOGE", notionalUsd: 10 }, rule: "allowed-asset" },
    { name: "asset on blocklist", action: { action: "buy", asset: "SHIB", notionalUsd: 10 }, rule: "blocked-asset" },
    { name: "venue not allowed", action: { action: "buy", asset: "ETH", notionalUsd: 10, venue: "cex-x" }, rule: "allowed-venue" },
    { name: "over per-asset cap", action: { action: "buy", asset: "CAKE", notionalUsd: 200 }, rule: "per-asset-cap" },
    { name: "over max notional", action: { action: "buy", asset: "ETH", notionalUsd: 5000 }, rule: "max-notional" },
    { name: "non-finite notional", action: { action: "buy", asset: "ETH", notionalUsd: Number.NaN }, rule: "sane-notional" },
    { name: "zero notional (default strict)", action: { action: "buy", asset: "ETH", notionalUsd: 0 }, rule: "sane-notional" },
    { name: "low confidence", action: { action: "buy", asset: "ETH", notionalUsd: 10, confidence: 0.2 }, rule: "min-confidence" },
    { name: "excess leverage", action: { action: "buy", asset: "ETH", notionalUsd: 10, leverage: 20 }, rule: "max-leverage" },
    { name: "price out of band", action: { action: "buy", asset: "ETH", notionalUsd: 10, price: 0.995 }, rule: "price-band" },
  ];

  for (const c of cases) {
    test(`blocks: ${c.name}`, () => {
      const gate = new ChpGate({ policy: basePolicy() });
      const d = gate.evaluate(c.action);
      assert.equal(d.state, "BLOCKED");
      assert.equal(d.allowed, false);
      const failed = d.provenance.claims.filter((cl) => !cl.passed).map((cl) => cl.rule);
      assert.ok(failed.includes(c.rule), `expected rule ${c.rule} in [${failed.join(", ")}]`);
      assert.equal(gate.getDailyNotionalUsd(), 0, "blocked actions never count against the daily cap");
    });
  }

  test("blocks when the projected daily cap is exceeded", () => {
    const gate = new ChpGate({ policy: basePolicy() });
    for (let i = 0; i < 5; i++) {
      assert.equal(gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 400 }).state, "LOCKED");
    }
    const d = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 400 });
    assert.equal(d.state, "BLOCKED");
    assert.match(d.reason, /daily-cap/);
  });

  test("allowZeroNotional lets an unsized action through (deepbook semantics)", () => {
    const gate = new ChpGate({ policy: basePolicy(), allowZeroNotional: true });
    const d = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 0 });
    assert.equal(d.state, "LOCKED");
  });
});

describe("ChpGate — HITL flow", () => {
  test("routes at/above-threshold notionals to HITL and approves by id", () => {
    const gate = new ChpGate({ policy: basePolicy() });
    const d = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 600 });
    assert.equal(d.state, "HITL_REQUIRED");
    assert.equal(d.allowed, false);
    assert.equal(d.requiresHuman, true);
    assert.equal(gate.getDailyNotionalUsd(), 0, "HITL-pending notional is not yet committed");
    assert.equal(gate.getPendingHitl().size, 1);

    const approved = gate.approveHuman(d.provenance.decisionId, "sam@cubiczan.com");
    assert.equal(approved.state, "LOCKED");
    assert.equal(approved.allowed, true);
    assert.match(approved.reason, /sam@cubiczan.com/);
    assert.equal(gate.getDailyNotionalUsd(), 600);
    assert.equal(gate.getPendingHitl().size, 0);
  });

  test("approveHuman throws on an unknown or already-resolved id", () => {
    const gate = new ChpGate({ policy: basePolicy() });
    const d = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 600 });
    gate.approveHuman(d.provenance.decisionId, "sam");
    assert.throws(() => gate.approveHuman(d.provenance.decisionId, "sam"), /unknown or already-resolved/);
    assert.throws(() => gate.approveHuman("nope", "sam"), /unknown or already-resolved/);
  });

  test("approval re-checks hard caps and can still BLOCK", () => {
    const gate = new ChpGate({ policy: basePolicy() });
    const h1 = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 900 });
    const h2 = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 900 });
    const h3 = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 900 });
    assert.equal(gate.approveHuman(h1.provenance.decisionId, "sam").state, "LOCKED");
    assert.equal(gate.approveHuman(h2.provenance.decisionId, "sam").state, "LOCKED");
    // 900 + 900 + 900 > 2000 daily cap -> the third approval is rejected.
    const rejected = gate.approveHuman(h3.provenance.decisionId, "sam");
    assert.equal(rejected.state, "BLOCKED");
    assert.match(rejected.reason, /exceeds hard caps/);
    assert.equal(gate.getDailyNotionalUsd(), 1800);
  });
});

describe("ChpGate — daily cap persistence across restarts", () => {
  test("a restarted gate remembers the spent notional", () => {
    const statePath = join(dir, "daily.json");
    const gate1 = new ChpGate({ policy: basePolicy(), statePath });
    assert.equal(gate1.evaluate({ action: "buy", asset: "ETH", notionalUsd: 400 }).state, "LOCKED");
    assert.equal(gate1.evaluate({ action: "buy", asset: "ETH", notionalUsd: 400 }).state, "LOCKED");

    // "Restart": a brand-new gate instance sharing the state file.
    const gate2 = new ChpGate({ policy: basePolicy(), statePath });
    assert.equal(gate2.getDailyNotionalUsd(), 800);
    // 800 already spent + 1300 would breach the 2000 cap even though 1300 > max anyway; use 1201.
    const d = gate2.evaluate({ action: "buy", asset: "ETH", notionalUsd: 999, confidence: 0.9 });
    assert.equal(d.state, "HITL_REQUIRED"); // over HITL threshold but under caps
    const approved = gate2.approveHuman(d.provenance.decisionId, "sam");
    assert.equal(approved.state, "LOCKED");
    const blocked = gate2.evaluate({ action: "buy", asset: "ETH", notionalUsd: 400 });
    assert.equal(blocked.state, "BLOCKED");
    assert.match(blocked.reason, /daily-cap/);
  });

  test("the window rolls over after 24h and resets the persisted state", () => {
    const statePath = join(dir, "daily.json");
    let now = 1_000_000_000_000;
    const clock = () => now;
    const gate = new ChpGate({ policy: basePolicy(), statePath, clock });
    assert.equal(gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 400 }).state, "LOCKED");
    assert.equal(gate.getDailyNotionalUsd(), 400);

    now += 25 * 60 * 60 * 1000; // +25h
    assert.equal(gate.getDailyNotionalUsd(), 0);

    // A restart after the rollover also starts clean.
    const gate2 = new ChpGate({ policy: basePolicy(), statePath, clock });
    assert.equal(gate2.getDailyNotionalUsd(), 0);
  });

  test("a corrupt state file fails conservative (fresh window)", () => {
    const statePath = join(dir, "daily.json");
    writeFileSync(statePath, "{not json");
    const gate = new ChpGate({ policy: basePolicy(), statePath });
    assert.equal(gate.getDailyNotionalUsd(), 0);
    assert.equal(gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 100 }).state, "LOCKED");
  });
});

describe("ChpGate — typed event hooks", () => {
  test("fires onLocked / onHitl / onBlocked and supports on()/unsubscribe", () => {
    const seen: Record<string, ChpDecision[]> = { blocked: [], hitl: [], locked: [] };
    const gate = new ChpGate({
      policy: basePolicy(),
      hooks: {
        onBlocked: (d) => seen.blocked!.push(d),
        onHitl: (d) => seen.hitl!.push(d),
        onLocked: (d) => seen.locked!.push(d),
      },
    });
    let extra = 0;
    const off = gate.on("locked", () => { extra++; });

    gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 100 }); // locked
    const h = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 600 }); // hitl
    gate.evaluate({ action: "short", asset: "ETH", notionalUsd: 100 }); // blocked
    gate.approveHuman(h.provenance.decisionId, "sam"); // locked

    assert.equal(seen.locked!.length, 2);
    assert.equal(seen.hitl!.length, 1);
    assert.equal(seen.blocked!.length, 1);
    assert.equal(extra, 2);

    off();
    gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 100 });
    assert.equal(extra, 2, "unsubscribed listener no longer fires");
    assert.equal(seen.locked!.length, 3);
  });

  test("a throwing hook never breaks the gate", () => {
    const gate = new ChpGate({
      policy: basePolicy(),
      hooks: { onLocked: () => { throw new Error("dashboard down"); } },
    });
    const d = gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 100 });
    assert.equal(d.state, "LOCKED");
  });
});

describe("ChpGate — policy hot-reload with validation", () => {
  test("reloadPolicy swaps in a valid new policy", () => {
    const policyPath = join(dir, "policy.yaml");
    writeFileSync(policyPath, "version: \"1.0\"\nmax_notional_usd: 100.0\nallowed_actions:\n  - buy\n");
    const gate = new ChpGate({ policyPath });
    assert.equal(gate.getPolicy().maxNotionalUsd, 100);
    assert.equal(gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 150 }).state, "BLOCKED");

    writeFileSync(policyPath, "version: \"1.1\"\nmax_notional_usd: 400.0\nhitl_threshold_usd: 500.0\nallowed_actions:\n  - buy\n");
    const result = gate.reloadPolicy();
    assert.equal(result.ok, true);
    assert.equal(gate.getPolicy().maxNotionalUsd, 400);
    assert.equal(gate.getPolicy().version, "1.1");
    assert.equal(gate.evaluate({ action: "buy", asset: "ETH", notionalUsd: 150 }).state, "LOCKED");
  });

  test("an invalid edit is rejected and the old policy stays in force", () => {
    const policyPath = join(dir, "policy.yaml");
    writeFileSync(policyPath, "version: \"1.0\"\nmax_notional_usd: 100.0\nallowed_actions:\n  - buy\n");
    const gate = new ChpGate({ policyPath });

    writeFileSync(policyPath, "version: \"1.1\"\nmin_confidence: 3.0\nallowed_actions:\n  - buy\n");
    const result = gate.reloadPolicy();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join("; "), /minConfidence/);
    assert.equal(gate.getPolicy().version, "1.0", "old policy retained");
    assert.equal(gate.getPolicy().maxNotionalUsd, 100);
  });

  test("constructor rejects an invalid policy object", () => {
    assert.throws(
      () => new ChpGate({ policy: { ...basePolicy(), minConfidence: 7 } }),
      /invalid policy/,
    );
  });
});
