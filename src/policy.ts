/**
 * @cubiczan/agent-governance — canonical risk Policy schema + loader.
 *
 * Unifies the CHP policy engines from the author's cognitrader-bsc,
 * deepbook-trading-agent, vaultmind and the Rust cleanmandate /
 * swarmfi-executor donors into one superset schema:
 *
 *   - per-action notional ceiling, rolling daily cap, HITL threshold
 *   - action / asset / venue allowlists (+ asset blocklist)
 *   - minimum signal confidence, optional max leverage
 *   - optional odds/price band
 *
 * Policies can be loaded from a flat YAML file (zero-dependency
 * purpose-built parser, as in the donors) or constructed from a plain
 * object with validation and clear errors. A conservative safe default
 * is always available and is the fallback for missing/unparseable files
 * in non-strict mode.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Inclusive band applied to a proposed price / odds value. */
export interface PriceBand {
  min?: number;
  max?: number;
}

/** Canonical governance policy for capital-moving agent actions. */
export interface Policy {
  version: string;
  /** Hard ceiling per single action (USD-equivalent). Above => BLOCKED. */
  maxNotionalUsd: number;
  /** Rolling daily cumulative notional cap (USD-equivalent). */
  dailyNotionalCapUsd: number;
  /** HITL threshold. At/above => human approval required. */
  hitlThresholdUsd: number;
  /** Actions the agent may take at all (e.g. "buy", "swap", "LONG"). */
  allowedActions: string[];
  /** Per-asset (or per-pool) notional caps. Omitted assets fall back to maxNotionalUsd. 0 blocks the asset. */
  perAssetLimits: Record<string, number>;
  /** Minimum signal confidence (0..1) when a confidence is supplied. */
  minConfidence: number;
  /** Optional asset allowlist. When set, actions on other assets are BLOCKED. */
  allowedAssets?: string[];
  /** Optional asset blocklist. Actions on these assets are BLOCKED. */
  blockedAssets?: string[];
  /** Optional venue allowlist. When set, actions carrying another venue are BLOCKED. */
  allowedVenues?: string[];
  /** Optional leverage ceiling. Actions carrying higher leverage are BLOCKED. */
  maxLeverage?: number;
  /** Optional odds/price band. Actions carrying an out-of-band price are BLOCKED. */
  priceBand?: PriceBand;
}

/** Backwards-compatible alias for the donor repos' type name. */
export type RiskPolicy = Policy;

/** Thrown by {@link createPolicy} / strict {@link loadPolicy} on invalid input. */
export class PolicyValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid policy: ${errors.join("; ")}`);
    this.name = "PolicyValidationError";
    this.errors = errors;
  }
}

/** Conservative built-in fallback used when no policy file is present. */
export function defaultPolicy(): Policy {
  return {
    version: "1.0-default",
    maxNotionalUsd: 1000.0,
    dailyNotionalCapUsd: 5000.0,
    hitlThresholdUsd: 250.0,
    allowedActions: ["buy", "sell"],
    perAssetLimits: {},
    minConfidence: 0.6,
  };
}

/** Default location of the policy file (config/policy.yaml under cwd). */
export function defaultPolicyPath(): string {
  return resolve(process.cwd(), "config", "policy.yaml");
}

/**
 * Validate a policy object. Returns a list of human-readable errors
 * (empty when the policy is valid).
 */
export function validatePolicy(p: Policy): string[] {
  const errors: string[] = [];
  const nonNegNumber = (name: string, v: unknown): void => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      errors.push(`${name} must be a finite number >= 0 (got ${JSON.stringify(v)})`);
    }
  };

  if (typeof p.version !== "string" || p.version.trim() === "") {
    errors.push(`version must be a non-empty string (got ${JSON.stringify(p.version)})`);
  }
  nonNegNumber("maxNotionalUsd", p.maxNotionalUsd);
  nonNegNumber("dailyNotionalCapUsd", p.dailyNotionalCapUsd);
  nonNegNumber("hitlThresholdUsd", p.hitlThresholdUsd);

  if (!Array.isArray(p.allowedActions) || p.allowedActions.length === 0) {
    errors.push("allowedActions must be a non-empty string array");
  } else if (p.allowedActions.some((a) => typeof a !== "string" || a.trim() === "")) {
    errors.push("allowedActions entries must be non-empty strings");
  }

  if (p.perAssetLimits === null || typeof p.perAssetLimits !== "object" || Array.isArray(p.perAssetLimits)) {
    errors.push("perAssetLimits must be an object mapping asset -> cap");
  } else {
    for (const [asset, cap] of Object.entries(p.perAssetLimits)) {
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) {
        errors.push(`perAssetLimits.${asset} must be a finite number >= 0 (got ${JSON.stringify(cap)})`);
      }
    }
  }

  if (typeof p.minConfidence !== "number" || !Number.isFinite(p.minConfidence) || p.minConfidence < 0 || p.minConfidence > 1) {
    errors.push(`minConfidence must be a number in [0, 1] (got ${JSON.stringify(p.minConfidence)})`);
  }

  const optStringList = (name: string, v: unknown): void => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s.trim() === "")) {
      errors.push(`${name} must be an array of non-empty strings when set`);
    }
  };
  optStringList("allowedAssets", p.allowedAssets);
  optStringList("blockedAssets", p.blockedAssets);
  optStringList("allowedVenues", p.allowedVenues);

  if (p.maxLeverage !== undefined) {
    if (typeof p.maxLeverage !== "number" || !Number.isFinite(p.maxLeverage) || p.maxLeverage <= 0) {
      errors.push(`maxLeverage must be a finite number > 0 when set (got ${JSON.stringify(p.maxLeverage)})`);
    }
  }

  if (p.priceBand !== undefined) {
    const { min, max } = p.priceBand;
    const bad = (v: unknown): boolean => v !== undefined && (typeof v !== "number" || !Number.isFinite(v));
    if (p.priceBand === null || typeof p.priceBand !== "object" || bad(min) || bad(max)) {
      errors.push("priceBand.min / priceBand.max must be finite numbers when set");
    } else if (min !== undefined && max !== undefined && min > max) {
      errors.push(`priceBand.min (${min}) must be <= priceBand.max (${max})`);
    }
  }

  return errors;
}

/**
 * Construct a policy from a plain object. Unspecified fields fall back to the
 * conservative default. Throws {@link PolicyValidationError} on invalid input.
 */
export function createPolicy(input: Partial<Policy> = {}): Policy {
  const policy: Policy = { ...defaultPolicy(), ...input };
  const errors = validatePolicy(policy);
  if (errors.length > 0) throw new PolicyValidationError(errors);
  return policy;
}

export interface LoadPolicyOptions {
  /**
   * Strict mode: throw on a missing file, a parse failure, or validation
   * errors instead of falling back to the conservative default.
   */
  strict?: boolean;
  /** Warning sink for non-strict fallbacks. Defaults to console.warn. */
  warn?: (message: string) => void;
}

/**
 * Load a policy from a flat YAML file.
 *
 * Non-strict (default, donor-compatible): a missing, unparseable, or invalid
 * file logs a warning and returns the conservative default — the gate is
 * intentionally non-breaking. Strict: those conditions throw.
 */
export function loadPolicy(
  policyPath: string = defaultPolicyPath(),
  options: LoadPolicyOptions = {},
): Policy {
  const warn = options.warn ?? ((m: string) => console.warn(m));

  if (!existsSync(policyPath)) {
    if (options.strict) throw new Error(`[agent-governance] policy file not found: ${policyPath}`);
    warn(`[agent-governance] policy file not found at ${policyPath} — using conservative default policy`);
    return defaultPolicy();
  }

  let coerced: Policy;
  try {
    const raw = readFileSync(policyPath, "utf8");
    coerced = coercePolicy(parseFlatYaml(raw));
  } catch (err) {
    if (options.strict) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[agent-governance] failed to parse policy ${policyPath} (${msg}) — using default policy`);
    return defaultPolicy();
  }

  const errors = validatePolicy(coerced);
  if (errors.length > 0) {
    if (options.strict) throw new PolicyValidationError(errors);
    warn(`[agent-governance] policy ${policyPath} failed validation (${errors.join("; ")}) — using default policy`);
    return defaultPolicy();
  }
  return coerced;
}

/* ─── Minimal flat-YAML parser (donor scheme, zero dependencies) ────────────
 * Supports `key: value` scalars, a top-level `key:` followed by indented
 * `- item` list entries, a top-level `key:` followed by indented
 * `subkey: value` numeric maps, and inline `{}` / `[]`. Comments (`#`) and
 * blank lines are ignored. This covers the policy schema exactly; anything
 * richer is out of scope and falls through to the default policy.
 */
type YamlValue = string | number | boolean | string[] | Record<string, number>;

export function parseFlatYaml(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = stripComment(lines[i] as string);
    if (line.trim() === "") { i++; continue; }
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1] as string;
    const inline = (m[2] as string).trim();
    if (inline === "{}") { out[key] = {}; i++; continue; }
    if (inline === "[]") { out[key] = []; i++; continue; }
    if (inline !== "") { out[key] = parseScalar(inline); i++; continue; }
    // Block: collect indented children (list entries or a numeric map).
    const list: string[] = [];
    const map: Record<string, number> = {};
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j] as string)) {
      const t = stripComment(lines[j] as string).trim();
      j++;
      if (t === "") continue;
      if (t.startsWith("- ")) {
        list.push(stripQuotes(t.slice(2).trim()));
      } else {
        const cm = /^(.+?):\s*(.*)$/.exec(t);
        if (cm) map[stripQuotes((cm[1] as string).trim())] = Number((cm[2] as string).trim());
      }
    }
    out[key] = list.length > 0 ? list : map;
    i = j;
  }
  return out;
}

function stripComment(line: string): string {
  // Only strip `#` that is not inside quotes (the policy schema has no quoted #).
  const idx = line.indexOf("#");
  return idx === -1 ? line : line.slice(0, idx);
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function parseScalar(s: string): string | number | boolean {
  // Quoted scalars are always strings (fixes the donor parsers' loss of
  // quoted numeric-looking values such as version: "2.0").
  if (/^(["']).*\1$/.test(s)) return stripQuotes(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

function coercePolicy(p: Record<string, YamlValue>): Policy {
  const d = defaultPolicy();
  const num = (k: string, fallback: number): number =>
    typeof p[k] === "number" ? (p[k] as number) : fallback;
  const optNum = (k: string): number | undefined =>
    typeof p[k] === "number" ? (p[k] as number) : undefined;
  const strList = (k: string): string[] | undefined =>
    Array.isArray(p[k]) ? (p[k] as string[]) : undefined;

  const perAsset = p["per_asset_limits"] && !Array.isArray(p["per_asset_limits"]) && typeof p["per_asset_limits"] === "object"
    ? (p["per_asset_limits"] as Record<string, number>)
    : {};

  const band: PriceBand | undefined = (() => {
    const raw = p["price_band"];
    if (!raw || Array.isArray(raw) || typeof raw !== "object") return undefined;
    const m = raw as Record<string, number>;
    const out: PriceBand = {};
    if (typeof m["min"] === "number") out.min = m["min"];
    if (typeof m["max"] === "number") out.max = m["max"];
    return out.min === undefined && out.max === undefined ? undefined : out;
  })();

  const policy: Policy = {
    version:
      typeof p["version"] === "string"
        ? (p["version"] as string)
        : typeof p["version"] === "number"
          ? String(p["version"])
          : d.version,
    maxNotionalUsd: num("max_notional_usd", d.maxNotionalUsd),
    dailyNotionalCapUsd: num("daily_notional_cap_usd", d.dailyNotionalCapUsd),
    hitlThresholdUsd: num("hitl_threshold_usd", d.hitlThresholdUsd),
    allowedActions: strList("allowed_actions") ?? d.allowedActions,
    perAssetLimits: perAsset,
    minConfidence: num("min_confidence", d.minConfidence),
  };
  const allowedAssets = strList("allowed_assets");
  if (allowedAssets !== undefined) policy.allowedAssets = allowedAssets;
  const blockedAssets = strList("blocked_assets");
  if (blockedAssets !== undefined) policy.blockedAssets = blockedAssets;
  const allowedVenues = strList("allowed_venues");
  if (allowedVenues !== undefined) policy.allowedVenues = allowedVenues;
  const maxLeverage = optNum("max_leverage");
  if (maxLeverage !== undefined) policy.maxLeverage = maxLeverage;
  if (band !== undefined) policy.priceBand = band;
  return policy;
}
