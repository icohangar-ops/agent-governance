/**
 * @cubiczan/agent-governance — governance and audit layer for AI agents that
 * move capital.
 *
 * Copyright (c) 2026 Shyam Desigan (Cubiczan). All rights reserved.
 * Proprietary and confidential — see LICENSE.md.
 */

// Policy: canonical schema, loader, construction + validation.
export {
  defaultPolicy,
  defaultPolicyPath,
  loadPolicy,
  createPolicy,
  validatePolicy,
  parseFlatYaml,
  PolicyValidationError,
  type Policy,
  type RiskPolicy,
  type PriceBand,
  type LoadPolicyOptions,
} from "./policy.js";

// Gate: CHP decision states, evaluation, HITL, hot-reload, hooks.
export {
  ChpGate,
  type ChpGateOptions,
  type ChpState,
  type ChpDecision,
  type ProposedAction,
  type Provenance,
  type Claim,
  type DecisionSink,
  type GateHooks,
  type GateEventName,
  type ReloadResult,
} from "./gate.js";

// Ledger: signed, chained, append-only JSONL audit log.
export {
  AuditLedger,
  verifyLedger,
  canonicalJson,
  LedgerLockError,
  DEFAULT_AUDIT_LEDGER_KEY,
  AUDIT_LEDGER_KEY_ENV,
  type AuditLedgerOptions,
  type AuditRecord,
  type AuditRecordInput,
  type VerifyResult,
} from "./ledger.js";
