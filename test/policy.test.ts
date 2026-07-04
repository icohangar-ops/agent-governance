import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPolicy,
  defaultPolicy,
  loadPolicy,
  validatePolicy,
  PolicyValidationError,
} from "../src/policy.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const quiet = { warn: () => {} };

describe("defaultPolicy", () => {
  test("is conservative and valid", () => {
    const d = defaultPolicy();
    assert.equal(validatePolicy(d).length, 0);
    assert.ok(d.maxNotionalUsd <= 1000);
    assert.ok(d.hitlThresholdUsd < d.maxNotionalUsd);
    assert.ok(d.minConfidence >= 0.5);
  });
});

describe("createPolicy", () => {
  test("merges partial input over the conservative default", () => {
    const p = createPolicy({ maxNotionalUsd: 42, allowedActions: ["swap"] });
    assert.equal(p.maxNotionalUsd, 42);
    assert.deepEqual(p.allowedActions, ["swap"]);
    assert.equal(p.dailyNotionalCapUsd, defaultPolicy().dailyNotionalCapUsd);
  });

  test("throws PolicyValidationError with clear per-field errors", () => {
    try {
      createPolicy({
        maxNotionalUsd: -1,
        minConfidence: 2,
        allowedActions: [],
        priceBand: { min: 5, max: 1 },
      });
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof PolicyValidationError);
      const joined = err.errors.join("\n");
      assert.match(joined, /maxNotionalUsd/);
      assert.match(joined, /minConfidence/);
      assert.match(joined, /allowedActions/);
      assert.match(joined, /priceBand/);
    }
  });

  test("rejects a non-finite per-asset cap", () => {
    assert.throws(
      () => createPolicy({ perAssetLimits: { ETH: Number.NaN } }),
      PolicyValidationError,
    );
  });

  test("accepts the full superset schema", () => {
    const p = createPolicy({
      allowedAssets: ["ETH", "BTC"],
      blockedAssets: ["SHIB"],
      allowedVenues: ["hyperliquid"],
      maxLeverage: 5,
      priceBand: { min: 0.02, max: 0.98 },
    });
    assert.equal(validatePolicy(p).length, 0);
  });
});

describe("loadPolicy (flat YAML)", () => {
  test("parses the full superset schema", () => {
    const yamlPath = join(dir, "policy.yaml");
    writeFileSync(
      yamlPath,
      `
# governance policy
version: "2.0"
max_notional_usd: 5000.0
daily_notional_cap_usd: 20000.0
hitl_threshold_usd: 1000.0
allowed_actions:
  - buy
  - sell
per_asset_limits:
  ETH: 5000.0
  SOL: 3000.0
min_confidence: 0.65
allowed_assets:
  - ETH
  - SOL
blocked_assets: []
allowed_venues:
  - hyperliquid
  - polymarket
max_leverage: 5.0
price_band:
  min: 0.02
  max: 0.98
`,
    );
    const p = loadPolicy(yamlPath, { strict: true });
    assert.equal(p.version, "2.0");
    assert.equal(p.maxNotionalUsd, 5000);
    assert.equal(p.dailyNotionalCapUsd, 20000);
    assert.equal(p.hitlThresholdUsd, 1000);
    assert.deepEqual(p.allowedActions, ["buy", "sell"]);
    assert.deepEqual(p.perAssetLimits, { ETH: 5000, SOL: 3000 });
    assert.equal(p.minConfidence, 0.65);
    assert.deepEqual(p.allowedAssets, ["ETH", "SOL"]);
    assert.deepEqual(p.blockedAssets, []);
    assert.deepEqual(p.allowedVenues, ["hyperliquid", "polymarket"]);
    assert.equal(p.maxLeverage, 5);
    assert.deepEqual(p.priceBand, { min: 0.02, max: 0.98 });
  });

  test("parses donor-style minimal yaml with inline {}", () => {
    const yamlPath = join(dir, "policy.yaml");
    writeFileSync(
      yamlPath,
      `version: "1.0"
max_notional_usd: 50000.0
per_asset_limits: {}
min_confidence: 0.5
allowed_actions:
  - swap
`,
    );
    const p = loadPolicy(yamlPath, { strict: true });
    assert.equal(p.maxNotionalUsd, 50000);
    assert.deepEqual(p.perAssetLimits, {});
    assert.deepEqual(p.allowedActions, ["swap"]);
    assert.equal(p.priceBand, undefined);
  });

  test("missing file falls back to the conservative default (non-strict)", () => {
    const p = loadPolicy(join(dir, "nope.yaml"), quiet);
    assert.deepEqual(p, defaultPolicy());
  });

  test("missing file throws in strict mode", () => {
    assert.throws(() => loadPolicy(join(dir, "nope.yaml"), { strict: true }));
  });

  test("invalid values fall back to default (non-strict) and throw (strict)", () => {
    const yamlPath = join(dir, "bad.yaml");
    writeFileSync(yamlPath, "version: \"1.0\"\nmin_confidence: 2.0\n");
    const p = loadPolicy(yamlPath, quiet);
    assert.deepEqual(p, defaultPolicy());
    assert.throws(
      () => loadPolicy(yamlPath, { strict: true }),
      PolicyValidationError,
    );
  });
});
