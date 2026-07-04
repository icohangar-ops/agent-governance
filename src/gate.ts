/**
 * @cubiczan/agent-governance — canonical CHP Decision Gate.
 *
 * Unifies the CHP gates from the author's cognitrader-bsc,
 * deepbook-trading-agent and vaultmind donors (themselves ports of the Rust
 * cleanmandate / swarmfi-executor CHP crates):
 *
 *   - drives a proposed capital-moving action through decision states
 *       EXPLORING -> PROVISIONAL -> LOCKED (or BLOCKED / HITL_REQUIRED)
 *   - runs policy + adversarial / sanity checks and records per-decision
 *     provenance (decision id, content hash, per-claim pass/fail)
 *   - BLOCKS or requires HITL approval when notional exceeds thresholds
 *
 * Hardening the public donors lack:
 *
 *   - decisions are (pluggably) auto-appended to a signed AuditLedger
 *   - the rolling daily notional cap persists across restarts (statePath)
 *   - policy hot-reload with validation (reloadPolicy / watchPolicy)
 *   - typed event hooks: onBlocked / onHitl / onLocked
 *
 * Capital-moving actions must pass gate.evaluate(action) before submission.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  defaultPolicyPath,
  loadPolicy,
  validatePolicy,
  type Policy,
} from "./policy.js";
import type { AuditRecordInput } from "./ledger.js";

/** Lifecycle states a proposed action moves through. */
export type ChpState =
  | "EXPLORING" // received, not yet checked
  | "PROVISIONAL" // passed policy + sanity, pending final lock/HITL
  | "LOCKED" // approved for execution
  | "HITL_REQUIRED" // blocked pending human approval
  | "BLOCKED"; // rejected outright

/** A capital-moving action proposed to the gate. */
export interface ProposedAction {
  /** Action verb (must be in policy.allowedActions), e.g. "buy", "swap", "LONG". */
  action: string;
  /** Asset / token / pool the action targets (per-asset caps + provenance). */
  asset: string;
  /** Notional value of the action (USD-equivalent). */
  notionalUsd: number;
  /** Optional venue/exchange identifier (checked against policy.allowedVenues). */
  venue?: string;
  /** Signal confidence 0..1 (adversarial input; checked against policy.minConfidence). */
  confidence?: number;
  /** Optional leverage multiplier (checked against policy.maxLeverage). */
  leverage?: number;
  /** Optional execution price / odds (checked against policy.priceBand). */
  price?: number;
  /** Free-form rationale carried into provenance. */
  rationale?: string;
}

/** One evaluated rule and its outcome, recorded in provenance. */
export interface Claim {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface Provenance {
  decisionId: string;
  timestamp: string;
  action: ProposedAction;
  state: ChpState;
  contentHash: string;
  /** Per-claim checks that were run and their pass/fail result. */
  claims: Claim[];
}

export interface ChpDecision {
  allowed: boolean;
  requiresHuman: boolean;
  state: ChpState;
  reason: string;
  provenance: Provenance;
}

/** Anything gate decisions can be audit-logged to. {@link AuditLedger} satisfies this. */
export interface DecisionSink {
  append(input: AuditRecordInput): string;
}

/** Typed event hooks for dashboards / alerting. */
export interface GateHooks {
  onBlocked?: (decision: ChpDecision) => void;
  onHitl?: (decision: ChpDecision) => void;
  onLocked?: (decision: ChpDecision) => void;
}

export type GateEventName = "blocked" | "hitl" | "locked";

/** Result of {@link ChpGate.reloadPolicy}. */
export type ReloadResult =
  | { ok: true; policy: Policy }
  | { ok: false; errors: string[] };

export interface ChpGateOptions {
  /** Use this policy object directly (validated); overrides policyPath. */
  policy?: Policy;
  /** Load (and hot-reload) the policy from this YAML file. Default config/policy.yaml. */
  policyPath?: string;
  /** Audit sink: every decision is appended here (e.g. a signed AuditLedger). */
  ledger?: DecisionSink;
  /** Actor name written to ledger records. Default "chp-gate". */
  actor?: string;
  /**
   * JSON file persisting the rolling daily notional window across restarts.
   * Written atomically (tmp + rename). Omit for in-memory-only (donor behavior).
   */
  statePath?: string;
  /**
   * Treat a notional of exactly 0 as "unsized — sized downstream" and let it
   * through the sanity check (deepbook donor semantics). Default false.
   */
  allowZeroNotional?: boolean;
  /** Typed event hooks (also attachable later via gate.on()). */
  hooks?: GateHooks;
  /** Clock override for tests. Default Date.now. */
  clock?: () => number;
}

interface DailyState {
  windowStart: number;
  notionalUsd: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class ChpGate {
  private policy: Policy;
  private readonly policyPath: string;
  private readonly ledger?: DecisionSink;
  private readonly actor: string;
  private readonly statePath?: string;
  private readonly allowZeroNotional: boolean;
  private readonly clock: () => number;

  private readonly decisions: Provenance[] = [];
  private readonly pendingHitl = new Map<string, ProposedAction>();
  private readonly listeners: Record<GateEventName, ((d: ChpDecision) => void)[]> = {
    blocked: [],
    hitl: [],
    locked: [],
  };

  private dailyNotionalUsd = 0;
  private dailyWindowStart: number;
  private watching = false;

  constructor(options: ChpGateOptions = {}) {
    this.policyPath = options.policyPath ?? defaultPolicyPath();
    if (options.policy) {
      const errors = validatePolicy(options.policy);
      if (errors.length > 0) {
        throw new Error(`invalid policy passed to ChpGate: ${errors.join("; ")}`);
      }
      this.policy = options.policy;
    } else {
      this.policy = loadPolicy(this.policyPath);
    }
    if (options.ledger !== undefined) this.ledger = options.ledger;
    this.actor = options.actor ?? "chp-gate";
    if (options.statePath !== undefined) this.statePath = options.statePath;
    this.allowZeroNotional = options.allowZeroNotional ?? false;
    this.clock = options.clock ?? Date.now;
    this.dailyWindowStart = this.clock();
    if (options.hooks) {
      if (options.hooks.onBlocked) this.listeners.blocked.push(options.hooks.onBlocked);
      if (options.hooks.onHitl) this.listeners.hitl.push(options.hooks.onHitl);
      if (options.hooks.onLocked) this.listeners.locked.push(options.hooks.onLocked);
    }
    this.loadDailyState();
  }

  getPolicy(): Policy {
    return this.policy;
  }

  /** Append-only in-memory provenance ledger (per-decision records). */
  getDecisions(): readonly Provenance[] {
    return this.decisions;
  }

  /** Actions awaiting human approval, keyed by decisionId. */
  getPendingHitl(): ReadonlyMap<string, ProposedAction> {
    return this.pendingHitl;
  }

  /** Notional already locked in the current rolling daily window. */
  getDailyNotionalUsd(): number {
    this.rollDailyWindow();
    return this.dailyNotionalUsd;
  }

  /** Attach a typed event listener. Returns an unsubscribe function. */
  on(event: GateEventName, listener: (decision: ChpDecision) => void): () => void {
    this.listeners[event].push(listener);
    return () => {
      const idx = this.listeners[event].indexOf(listener);
      if (idx >= 0) this.listeners[event].splice(idx, 1);
    };
  }

  /**
   * Evaluate a proposed capital-moving action.
   *
   * States: EXPLORING (received) -> run policy + adversarial checks.
   *   - any hard violation                => BLOCKED  (allowed=false)
   *   - notional >= hitl_threshold        => HITL_REQUIRED (allowed=false, requiresHuman)
   *   - otherwise                         => PROVISIONAL -> LOCKED (allowed=true)
   */
  evaluate(proposed: ProposedAction): ChpDecision {
    const claims: Claim[] = [];
    const add = (rule: string, passed: boolean, detail: string): void => {
      claims.push({ rule, passed, detail });
    };

    // ── Policy checks (hard blocks) ──────────────────────────
    const actionAllowed = this.policy.allowedActions.includes(proposed.action);
    add("allowed-action", actionAllowed, `action ${proposed.action}`);

    let assetAllowed = true;
    if (this.policy.allowedAssets !== undefined) {
      assetAllowed = this.policy.allowedAssets.includes(proposed.asset);
      add("allowed-asset", assetAllowed, `asset ${proposed.asset} vs allowlist [${this.policy.allowedAssets.join(", ")}]`);
    }
    let assetNotBlocked = true;
    if (this.policy.blockedAssets !== undefined) {
      assetNotBlocked = !this.policy.blockedAssets.includes(proposed.asset);
      add("blocked-asset", assetNotBlocked, `asset ${proposed.asset} vs blocklist [${this.policy.blockedAssets.join(", ")}]`);
    }

    let venueAllowed = true;
    if (this.policy.allowedVenues !== undefined && proposed.venue !== undefined) {
      venueAllowed = this.policy.allowedVenues.includes(proposed.venue);
      add("allowed-venue", venueAllowed, `venue ${proposed.venue} vs allowlist [${this.policy.allowedVenues.join(", ")}]`);
    }

    const assetCap = this.policy.perAssetLimits[proposed.asset];
    const effectiveCap = assetCap ?? this.policy.maxNotionalUsd;
    const underAssetCap = proposed.notionalUsd <= effectiveCap;
    add("per-asset-cap", underAssetCap, `${proposed.asset} notional $${proposed.notionalUsd} vs cap $${effectiveCap}`);

    const underMax = proposed.notionalUsd <= this.policy.maxNotionalUsd;
    add("max-notional", underMax, `$${proposed.notionalUsd} vs max $${this.policy.maxNotionalUsd}`);

    this.rollDailyWindow();
    const projectedDaily = this.dailyNotionalUsd + proposed.notionalUsd;
    const underDaily = projectedDaily <= this.policy.dailyNotionalCapUsd;
    add("daily-cap", underDaily, `projected $${projectedDaily} vs daily cap $${this.policy.dailyNotionalCapUsd}`);

    // ── Adversarial / sanity checks ──────────────────────────
    const sane = this.adversarialCheck(proposed, add);

    const hardOk =
      actionAllowed && assetAllowed && assetNotBlocked && venueAllowed &&
      underAssetCap && underMax && underDaily && sane;

    if (!hardOk) {
      const failed = claims.filter((c) => !c.passed).map((c) => c.rule);
      return this.finalize(proposed, "BLOCKED", claims, false, false, `blocked: ${failed.join(", ")}`);
    }

    // Passed all hard checks -> PROVISIONAL.

    // ── HITL threshold ───────────────────────────────────────
    if (proposed.notionalUsd >= this.policy.hitlThresholdUsd) {
      const decision = this.finalize(
        proposed,
        "HITL_REQUIRED",
        claims,
        false,
        true,
        `human approval required: $${proposed.notionalUsd} >= HITL threshold $${this.policy.hitlThresholdUsd}`,
      );
      this.pendingHitl.set(decision.provenance.decisionId, proposed);
      return decision;
    }

    // Auto-approve -> LOCKED and count against the daily cap.
    this.dailyNotionalUsd = projectedDaily;
    this.persistDailyState();
    return this.finalize(proposed, "LOCKED", claims, true, false, "auto-approved under CHP thresholds");
  }

  /**
   * Register an explicit human approval for a HITL-gated decision by its
   * decisionId, promoting it to LOCKED (mirrors the donor `principal_approve`).
   * Hard caps are re-checked at approval time; an approval that would breach
   * them is BLOCKED. Throws on an unknown / already-resolved decisionId.
   */
  approveHuman(decisionId: string, approver: string): ChpDecision {
    const proposed = this.pendingHitl.get(decisionId);
    if (!proposed) {
      throw new Error(`approveHuman: unknown or already-resolved decisionId ${decisionId}`);
    }
    this.pendingHitl.delete(decisionId);

    this.rollDailyWindow();
    const projectedDaily = this.dailyNotionalUsd + proposed.notionalUsd;
    if (projectedDaily > this.policy.dailyNotionalCapUsd || proposed.notionalUsd > this.policy.maxNotionalUsd) {
      return this.finalize(
        proposed,
        "BLOCKED",
        [{ rule: "post-approval-recheck", passed: false, detail: "exceeds hard caps even with approval" }],
        false,
        false,
        "human approval rejected: exceeds hard caps",
      );
    }
    this.dailyNotionalUsd = projectedDaily;
    this.persistDailyState();
    return this.finalize(
      proposed,
      "LOCKED",
      [{ rule: "human-approval", passed: true, detail: `approved by ${approver}` }],
      true,
      false,
      `human-approved by ${approver}`,
    );
  }

  /**
   * Re-load the policy from policyPath with strict parsing + validation.
   * The running policy is swapped only when the new one is valid; otherwise
   * the old policy stays in force and the errors are returned.
   */
  reloadPolicy(): ReloadResult {
    try {
      const next = loadPolicy(this.policyPath, { strict: true });
      this.policy = next;
      return { ok: true, policy: next };
    } catch (err) {
      const errors =
        err instanceof Error && "errors" in err && Array.isArray((err as { errors: unknown }).errors)
          ? ((err as { errors: string[] }).errors)
          : [err instanceof Error ? err.message : String(err)];
      return { ok: false, errors };
    }
  }

  /**
   * Poll policyPath and hot-reload it (with validation) when it changes.
   * The watcher is unref'ed so it never keeps the process alive.
   */
  watchPolicy(intervalMs = 5000, onReload?: (result: ReloadResult) => void): void {
    if (this.watching) return;
    this.watching = true;
    const watcher = watchFile(this.policyPath, { interval: intervalMs }, () => {
      const result = this.reloadPolicy();
      if (onReload) onReload(result);
    });
    watcher.unref();
  }

  /** Stop watching policyPath. */
  unwatchPolicy(): void {
    if (!this.watching) return;
    unwatchFile(this.policyPath);
    this.watching = false;
  }

  // ── Internals ──────────────────────────────────────────────

  private adversarialCheck(proposed: ProposedAction, add: (rule: string, passed: boolean, detail: string) => void): boolean {
    let ok = true;

    // Sanity: notional must be a finite, positive number (or exactly 0 when
    // allowZeroNotional is set — "unsized, sized downstream" semantics).
    const floor = this.allowZeroNotional ? 0 : Number.MIN_VALUE;
    const saneNotional = Number.isFinite(proposed.notionalUsd) && proposed.notionalUsd >= floor;
    add("sane-notional", saneNotional, `notional=${proposed.notionalUsd}`);
    if (!saneNotional) ok = false;

    // Adversarial: reject low-confidence signals ("what if this is noise?").
    if (proposed.confidence !== undefined) {
      const confidentEnough =
        Number.isFinite(proposed.confidence) && proposed.confidence >= this.policy.minConfidence;
      add("min-confidence", confidentEnough, `confidence ${proposed.confidence} vs min ${this.policy.minConfidence}`);
      if (!confidentEnough) ok = false;
    }

    // Adversarial: leverage ceiling (swarmfi-executor semantics).
    if (this.policy.maxLeverage !== undefined && proposed.leverage !== undefined) {
      const leverageOk = Number.isFinite(proposed.leverage) && proposed.leverage <= this.policy.maxLeverage;
      add("max-leverage", leverageOk, `leverage ${proposed.leverage} vs max ${this.policy.maxLeverage}`);
      if (!leverageOk) ok = false;
    }

    // Adversarial: odds/price band.
    if (this.policy.priceBand !== undefined && proposed.price !== undefined) {
      const { min, max } = this.policy.priceBand;
      const priceOk =
        Number.isFinite(proposed.price) &&
        (min === undefined || proposed.price >= min) &&
        (max === undefined || proposed.price <= max);
      add("price-band", priceOk, `price ${proposed.price} vs band [${min ?? "-inf"}, ${max ?? "+inf"}]`);
      if (!priceOk) ok = false;
    }

    return ok;
  }

  private rollDailyWindow(): void {
    if (this.clock() - this.dailyWindowStart >= DAY_MS) {
      this.dailyWindowStart = this.clock();
      this.dailyNotionalUsd = 0;
      this.persistDailyState();
    }
  }

  private loadDailyState(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<DailyState>;
      if (
        typeof parsed.windowStart === "number" && Number.isFinite(parsed.windowStart) &&
        typeof parsed.notionalUsd === "number" && Number.isFinite(parsed.notionalUsd) && parsed.notionalUsd >= 0
      ) {
        this.dailyWindowStart = parsed.windowStart;
        this.dailyNotionalUsd = parsed.notionalUsd;
        this.rollDailyWindow(); // expire a stale window immediately
      }
    } catch {
      // Corrupt state file: fail conservative — keep the fresh window (0 spent).
    }
  }

  private persistDailyState(): void {
    if (!this.statePath) return;
    const state: DailyState = {
      windowStart: this.dailyWindowStart,
      notionalUsd: this.dailyNotionalUsd,
    };
    const dir = dirname(this.statePath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.statePath); // atomic on POSIX
  }

  private finalize(
    action: ProposedAction,
    state: ChpState,
    claims: Claim[],
    allowed: boolean,
    requiresHuman: boolean,
    reason: string,
  ): ChpDecision {
    const timestamp = new Date().toISOString();
    const canonical = JSON.stringify({ action, state, claims, timestamp });
    const contentHash = createHash("sha256").update(canonical).digest("hex");
    const provenance: Provenance = {
      decisionId: randomUUID(),
      timestamp,
      action,
      state,
      contentHash,
      claims,
    };
    this.decisions.push(provenance);
    const decision: ChpDecision = { allowed, requiresHuman, state, reason, provenance };

    // Audit integration: every decision lands in the signed ledger. A failed
    // append (e.g. lock timeout) propagates — fail-closed, never unaudited.
    if (this.ledger) {
      this.ledger.append({
        event: `chp.${state.toLowerCase()}`,
        actor: this.actor,
        inputs: { decisionId: provenance.decisionId, action, claims, contentHash },
        sources: [`policy:${this.policy.version}`],
        ...(action.confidence !== undefined ? { confidence: action.confidence } : {}),
        rationale: reason,
        ts: timestamp,
      });
    }

    this.emit(state, decision);
    return decision;
  }

  private emit(state: ChpState, decision: ChpDecision): void {
    const event: GateEventName | undefined =
      state === "BLOCKED" ? "blocked" : state === "HITL_REQUIRED" ? "hitl" : state === "LOCKED" ? "locked" : undefined;
    if (!event) return;
    for (const listener of [...this.listeners[event]]) {
      try {
        listener(decision);
      } catch {
        // Hook errors must never break the gate.
      }
    }
  }
}
