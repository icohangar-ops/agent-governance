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
  type LedgerVerifyKey,
} from "./ledger.js";

// Finance-analysis adapter: classification, citations, period checks, HITL drafts.
export {
  FinanceAnalysisGate,
  defaultFinanceAnalysisPolicy,
  syntheticXeroPnlExport,
  syntheticXeroCommentaryDraft,
  hashSourceReport,
  hashDraft,
  inferReportAsset,
  isWriteTool,
  CLASSIFICATION_RANK,
  WRITE_TOOLS,
  READ_TOOLS,
  FINANCE_ALLOWED_ACTIONS,
  type DataClassification,
  type AccountingPeriod,
  type SourceLine,
  type SourceReport,
  type CitedFigure,
  type CommentaryDraft,
  type FinanceAnalysisRequest,
  type FinanceAnalysisGateOptions,
  type SealedDraft,
  type RetainedEvidence,
} from "./finance-analysis.js";

// Domain-event → HMAC ledger: entities raise facts; the handler attaches actor.
export {
  DomainEventLedgerHandler,
  Order,
  defaultDomainEventOrderPolicy,
  mapOrderEventToAction,
  syntheticOpenedOrder,
  domainEventFromRecord,
  domainEventsFromRecords,
  isDomainLedgerEvent,
  DOMAIN_LEDGER_EVENT_PREFIX,
  type DomainEvent,
  type DomainEventDispatch,
  type DomainEventHandlerOptions,
  type OrderState,
  type OpenOrderInput,
} from "./domain-events.js";
