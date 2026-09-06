/**
 * @cubiczan/agent-governance — finance-analysis policy adapter.
 *
 * Finance teams feed exported accounting reports (Xero-style P&L and the
 * like) to LLMs for variance commentary. Models routinely misread the
 * reporting window and overstate timing differences; they must not leak
 * restricted fields, mutate the ledger, or publish unsigned drafts.
 *
 * This adapter does **not** invent a parallel decision stack. It maps an
 * analysis-only request onto the canonical CHP gate:
 *
 *   - Policy: only `analyze` / `comment`; notional is always 0 (no capital
 *     movement); HITL threshold is 0 so every draft needs a human reviewer.
 *   - Extra claims (citation, period window, classification, read-only
 *     connector, signed draft, retained evidence) fold into `ChpGate.evaluate`.
 *   - HITL: reviewer assignment, then `approveHuman`.
 *   - Ledger: source-report evidence + sealed drafts are append-only HMAC
 *     records. There is no rewrite / delete path.
 *
 * Connector assumption: the export is already on disk (or a read-only API).
 * Write tools (post-journal, mutate-ledger, …) are denied at the claim
 * layer *and* fail the CHP allowed-action check.
 */

import { createHash } from "node:crypto";
import { ChpGate, type ChpDecision, type Claim, type DecisionSink, type GateHooks, type ProposedAction } from "./gate.js";
import { canonicalJson } from "./ledger.js";
import { createPolicy, type Policy } from "./policy.js";

/** Inclusive classification rank — higher is more sensitive. */
export type DataClassification = "public" | "internal" | "confidential" | "restricted";

export const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  /** Never ingested into an LLM context (bank accounts, payroll PII, tax IDs). */
  restricted: 3,
};

/** Connector / action names that would mutate books or the audit ledger. */
export const WRITE_TOOLS = [
  "post-journal",
  "write-ledger",
  "mutate-ledger",
  "create-invoice",
  "void-invoice",
  "reconcile-write",
  "ledger.rewrite",
  "ledger.delete",
  "ledger.update",
] as const;

export const READ_TOOLS = ["read-report", "list-reports", "export-pnl"] as const;

export const FINANCE_ALLOWED_ACTIONS = ["analyze", "comment"] as const;

/** Inclusive calendar window (`YYYY-MM-DD`, UTC date). */
export interface AccountingPeriod {
  start: string;
  end: string;
}

export interface SourceLine {
  lineId: string;
  accountCode: string;
  accountName: string;
  current: number;
  prior: number;
}

/**
 * A retained source report. `connectorMode` is always read-only — the
 * adapter never opens a write session against the accounting system.
 */
export interface SourceReport {
  reportId: string;
  /** Venue id checked against `policy.allowedVenues` (e.g. `xero-export`). */
  connector: string;
  connectorMode: "read-only";
  reportName: string;
  period: AccountingPeriod;
  comparisonPeriod?: AccountingPeriod;
  classification: DataClassification;
  /** SHA-256 of the canonical report payload (set by {@link hashSourceReport}). */
  contentHash: string;
  lines: SourceLine[];
  /**
   * Field names that must never enter an LLM prompt (account numbers, TFN,
   * payroll identifiers). A non-empty list fails `classification-ingest`.
   */
  restrictedFields?: string[];
}

export interface CitedFigure {
  label: string;
  value: number;
  sourceReportId: string;
  sourceLineId: string;
  field: "current" | "prior" | "variance";
}

export interface CommentaryDraft {
  draftId: string;
  period: AccountingPeriod;
  comparisonPeriod?: AccountingPeriod;
  figures: CitedFigure[];
  commentary: string;
  classification: DataClassification;
  /**
   * Set when the author acknowledged unequal period lengths (e.g. 31-day
   * March vs 28-day February). Required when day-counts differ, otherwise
   * the gate treats the commentary as an overstated timing difference.
   */
  periodLengthNoted?: boolean;
}

export interface FinanceAnalysisRequest {
  /** CHP action. Write verbs (`post-journal`, `mutate-ledger`, …) are blocked. */
  action: string;
  /** Report kind (`pnl`, `balance-sheet`, …). Inferred from the report name when omitted. */
  asset?: string;
  report: SourceReport;
  draft: CommentaryDraft;
  /** Connector tool the agent invoked. Write tools fail `connector-read-only`. */
  connectorTool: string;
  /** HMAC signature returned by {@link FinanceAnalysisGate.sealDraft}. */
  draftSig?: string;
  /** HMAC signature returned by {@link FinanceAnalysisGate.retainEvidence}. */
  evidenceSig?: string;
  confidence?: number;
}

export interface SealedDraft {
  draftId: string;
  draftHash: string;
  sig: string;
}

export interface RetainedEvidence {
  reportId: string;
  contentHash: string;
  sig: string;
}

export interface FinanceAnalysisGateOptions {
  /** Required: sealed drafts and evidence land on this sink (typically an AuditLedger). */
  ledger: DecisionSink;
  policy?: Policy;
  gate?: ChpGate;
  actor?: string;
  hooks?: GateHooks;
  /** Highest classification the agent may ingest. Default `confidential`. */
  maxIngestClassification?: DataClassification;
  /** When set, {@link FinanceAnalysisGate.assignReviewer} must pick from this pool. */
  reviewerPool?: readonly string[];
}

/** Analysis-only CHP policy: no capital movement, every draft is HITL. */
export function defaultFinanceAnalysisPolicy(): Policy {
  return createPolicy({
    version: "finance-analysis-1.0",
    maxNotionalUsd: 0,
    dailyNotionalCapUsd: 0,
    hitlThresholdUsd: 0,
    allowedActions: [...FINANCE_ALLOWED_ACTIONS],
    perAssetLimits: {},
    minConfidence: 0.7,
    allowedAssets: ["pnl", "balance-sheet", "trial-balance", "cash-flow"],
    allowedVenues: ["xero-export", "accounting-export"],
  });
}

export function isWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(name);
}

export function hashSourceReport(report: SourceReport): string {
  const { contentHash: _ignored, ...body } = report;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function hashDraft(draft: CommentaryDraft): string {
  return createHash("sha256").update(canonicalJson(draft)).digest("hex");
}

export function inferReportAsset(report: SourceReport): string {
  const n = report.reportName.toLowerCase();
  if (n.includes("balance")) return "balance-sheet";
  if (n.includes("trial")) return "trial-balance";
  if (n.includes("cash")) return "cash-flow";
  return "pnl";
}

/**
 * Synthetic Xero-style Profit and Loss export (not a real entity).
 *
 * March 2026 (31 days) compared with February 2026 (28 days) — the classic
 * window where an LLM overstates a timing difference if it ignores day-count.
 */
export function syntheticXeroPnlExport(): SourceReport {
  const report: SourceReport = {
    reportId: "xero-pnl-northwind-2026-03",
    connector: "xero-export",
    connectorMode: "read-only",
    reportName: "Profit and Loss",
    period: { start: "2026-03-01", end: "2026-03-31" },
    comparisonPeriod: { start: "2026-02-01", end: "2026-02-28" },
    classification: "confidential",
    contentHash: "",
    restrictedFields: [],
    lines: [
      { lineId: "l-200", accountCode: "200", accountName: "Sales", current: 125_000, prior: 110_000 },
      { lineId: "l-310", accountCode: "310", accountName: "Cost of Sales", current: 48_000, prior: 44_000 },
      { lineId: "l-gp", accountCode: "GP", accountName: "Gross Profit", current: 77_000, prior: 66_000 },
      { lineId: "l-429", accountCode: "429", accountName: "Operating Expenses", current: 31_000, prior: 29_000 },
      { lineId: "l-np", accountCode: "NP", accountName: "Net Profit", current: 46_000, prior: 37_000 },
    ],
  };
  return { ...report, contentHash: hashSourceReport(report) };
}

/**
 * A well-formed commentary draft over {@link syntheticXeroPnlExport}.
 * Period-length is noted so the 31-vs-28-day comparison is not treated as
 * an unadjusted timing overstatement.
 */
export function syntheticXeroCommentaryDraft(): CommentaryDraft {
  return {
    draftId: "draft-northwind-2026-03-v1",
    period: { start: "2026-03-01", end: "2026-03-31" },
    comparisonPeriod: { start: "2026-02-01", end: "2026-02-28" },
    periodLengthNoted: true,
    classification: "confidential",
    commentary:
      "Net profit $46,000 vs $37,000 prior. March has 31 days against February's 28, so the $9,000 lift is not a pure run-rate improvement.",
    figures: [
      { label: "Net Profit (current)", value: 46_000, sourceReportId: "xero-pnl-northwind-2026-03", sourceLineId: "l-np", field: "current" },
      { label: "Net Profit (prior)", value: 37_000, sourceReportId: "xero-pnl-northwind-2026-03", sourceLineId: "l-np", field: "prior" },
      { label: "Net Profit variance", value: 9_000, sourceReportId: "xero-pnl-northwind-2026-03", sourceLineId: "l-np", field: "variance" },
    ],
  };
}

/**
 * Analysis-only adapter over {@link ChpGate} + a signed {@link DecisionSink}.
 * Write tools and ledger mutation throw; drafts are sealed before HITL.
 */
export class FinanceAnalysisGate {
  private readonly gate: ChpGate;
  private readonly ledger: DecisionSink;
  private readonly actor: string;
  private readonly maxIngestClassification: DataClassification;
  private readonly reviewerPool?: readonly string[];
  private readonly assignedReviewers = new Map<string, string>();
  private readonly sealedDrafts = new Map<string, SealedDraft>();
  private readonly retainedEvidence = new Map<string, RetainedEvidence>();

  constructor(options: FinanceAnalysisGateOptions) {
    this.ledger = options.ledger;
    this.actor = options.actor ?? "finance-analysis-gate";
    this.maxIngestClassification = options.maxIngestClassification ?? "confidential";
    if (options.reviewerPool !== undefined) this.reviewerPool = options.reviewerPool;
    this.gate =
      options.gate ??
      new ChpGate({
        policy: options.policy ?? defaultFinanceAnalysisPolicy(),
        ledger: options.ledger,
        actor: this.actor,
        allowZeroNotional: true,
        ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
      });
  }

  getChpGate(): ChpGate {
    return this.gate;
  }

  getAssignedReviewer(decisionId: string): string | undefined {
    return this.assignedReviewers.get(decisionId);
  }

  /**
   * Persist the source report (content hash + lines) on the append-only
   * ledger. Required before {@link evaluate}.
   */
  retainEvidence(report: SourceReport): RetainedEvidence {
    const contentHash = report.contentHash || hashSourceReport(report);
    const sig = this.ledger.append({
      event: "finance.evidence.retained",
      actor: this.actor,
      inputs: {
        reportId: report.reportId,
        contentHash,
        period: report.period,
        comparisonPeriod: report.comparisonPeriod ?? null,
        classification: report.classification,
        lineIds: report.lines.map((l) => l.lineId),
      },
      sources: [`report:${report.reportId}`, `connector:${report.connector}`],
      rationale: `retained ${report.reportName} ${report.period.start}..${report.period.end}`,
    });
    const retained: RetainedEvidence = { reportId: report.reportId, contentHash, sig };
    this.retainedEvidence.set(report.reportId, retained);
    return retained;
  }

  /**
   * Seal a draft as an immutable ledger record. Subsequent edits change the
   * content hash and fail `signed-draft` unless the draft is sealed again
   * (a new append — the old record is never rewritten).
   */
  sealDraft(draft: CommentaryDraft): SealedDraft {
    const draftHash = hashDraft(draft);
    const sig = this.ledger.append({
      event: "finance.draft.sealed",
      actor: this.actor,
      inputs: { draftId: draft.draftId, draftHash, draft },
      sources: draft.figures.map((f) => `report:${f.sourceReportId}#${f.sourceLineId}`),
      rationale: `sealed immutable draft ${draft.draftId}`,
    });
    const sealed: SealedDraft = { draftId: draft.draftId, draftHash, sig };
    this.sealedDrafts.set(draft.draftId, sealed);
    return sealed;
  }

  /**
   * Run finance claims through the CHP gate. Happy-path analysis is always
   * `HITL_REQUIRED` (zero HITL threshold). Write / mutate actions are
   * `BLOCKED`.
   */
  evaluate(request: FinanceAnalysisRequest): ChpDecision {
    const extra = this.financeClaims(request);
    return this.gate.evaluate(this.toProposedAction(request), extra);
  }

  /**
   * Bind a pending HITL decision to a named reviewer. Required before
   * {@link approveCommentary}.
   */
  assignReviewer(decisionId: string, reviewer: string): void {
    if (!this.gate.getPendingHitl().has(decisionId)) {
      throw new Error(`assignReviewer: unknown or not-pending HITL decisionId ${decisionId}`);
    }
    if (this.reviewerPool && !this.reviewerPool.includes(reviewer)) {
      throw new Error(`assignReviewer: ${reviewer} is not in the reviewer pool`);
    }
    this.assignedReviewers.set(decisionId, reviewer);
    this.ledger.append({
      event: "finance.reviewer.assigned",
      actor: this.actor,
      inputs: { decisionId, reviewer },
      sources: [`policy:${this.gate.getPolicy().version}`],
      rationale: `reviewer ${reviewer} assigned`,
    });
  }

  /** Promote a HITL-gated commentary. Approver must be the assigned reviewer. */
  approveCommentary(decisionId: string, approver: string): ChpDecision {
    const assigned = this.assignedReviewers.get(decisionId);
    if (!assigned) {
      throw new Error(`approveCommentary: no reviewer assigned for ${decisionId}`);
    }
    if (assigned !== approver) {
      throw new Error(`approveCommentary: ${approver} is not the assigned reviewer (${assigned})`);
    }
    const decision = this.gate.approveHuman(decisionId, approver);
    this.assignedReviewers.delete(decisionId);
    return decision;
  }

  /**
   * Ledger mutation is not offered. The underlying {@link AuditLedger} is
   * append-only; this method exists so agents that probe for a write API
   * get an explicit denial rather than a missing-method surprise.
   */
  mutateLedger(): never {
    throw new Error("finance-analysis is read-only: ledger mutation is denied");
  }

  /** Direct write-tool invocation is denied (same rule as `connector-read-only`). */
  invokeConnectorWrite(tool: string): never {
    throw new Error(`finance-analysis is read-only: ${tool} is denied`);
  }

  // ── Internals ──────────────────────────────────────────────

  private toProposedAction(request: FinanceAnalysisRequest): ProposedAction {
    const proposed: ProposedAction = {
      action: request.action,
      asset: request.asset ?? inferReportAsset(request.report),
      notionalUsd: 0,
      venue: request.report.connector,
      rationale: request.draft.commentary,
    };
    if (request.confidence !== undefined) proposed.confidence = request.confidence;
    return proposed;
  }

  private financeClaims(request: FinanceAnalysisRequest): Claim[] {
    const claims: Claim[] = [];
    const add = (rule: string, passed: boolean, detail: string): void => {
      claims.push({ rule, passed, detail });
    };

    const writeAttempt = isWriteTool(request.action) || isWriteTool(request.connectorTool);
    add(
      "connector-read-only",
      request.report.connectorMode === "read-only" && !writeAttempt,
      writeAttempt
        ? `write tool denied: action=${request.action} tool=${request.connectorTool}`
        : `connector ${request.report.connector} is read-only`,
    );

    const restrictedLeak =
      request.report.classification === "restricted" ||
      (request.report.restrictedFields !== undefined && request.report.restrictedFields.length > 0);
    const rankOk =
      CLASSIFICATION_RANK[request.report.classification] <=
      CLASSIFICATION_RANK[this.maxIngestClassification];
    add(
      "classification-ingest",
      rankOk && !restrictedLeak,
      restrictedLeak
        ? "restricted data must not enter the analysis context"
        : `classification ${request.report.classification} vs max ${this.maxIngestClassification}`,
    );

    const evidence = this.retainedEvidence.get(request.report.reportId);
    const evidenceOk =
      evidence !== undefined &&
      evidence.contentHash === request.report.contentHash &&
      (request.evidenceSig === undefined || request.evidenceSig === evidence.sig);
    add(
      "evidence-retained",
      evidenceOk,
      evidenceOk
        ? `report ${request.report.reportId} hash ${request.report.contentHash}`
        : `source report ${request.report.reportId} is not retained`,
    );

    const draftHash = hashDraft(request.draft);
    const sealed = this.sealedDrafts.get(request.draft.draftId);
    const signedOk =
      request.draftSig !== undefined &&
      sealed !== undefined &&
      sealed.sig === request.draftSig &&
      sealed.draftHash === draftHash;
    add(
      "signed-draft",
      signedOk,
      signedOk
        ? `draft ${request.draft.draftId} sig ${request.draftSig}`
        : request.draftSig === undefined
          ? "unsigned draft rejected"
          : "draft signature does not match the sealed immutable draft (mutated or forged)",
    );

    const period = periodWindowClaim(request);
    add("period-window", period.passed, period.detail);

    const cite = sourceCitationClaim(request);
    add("source-citation", cite.passed, cite.detail);

    return claims;
  }
}

function periodWindowClaim(request: FinanceAnalysisRequest): { passed: boolean; detail: string } {
  const draftP = request.draft.period;
  const reportP = request.report.period;
  if (!validPeriod(draftP) || !validPeriod(reportP)) {
    return { passed: false, detail: "period start/end must be valid YYYY-MM-DD windows" };
  }
  if (draftP.start !== reportP.start || draftP.end !== reportP.end) {
    return {
      passed: false,
      detail: `draft window ${draftP.start}..${draftP.end} != report ${reportP.start}..${reportP.end}`,
    };
  }
  if (request.draft.comparisonPeriod !== undefined) {
    const reported = request.report.comparisonPeriod;
    const claimed = request.draft.comparisonPeriod;
    if (!reported || claimed.start !== reported.start || claimed.end !== reported.end) {
      return {
        passed: false,
        detail: `comparison window ${claimed.start}..${claimed.end} != report ${reported ? `${reported.start}..${reported.end}` : "(none)"}`,
      };
    }
    if (!validPeriod(claimed) || !validPeriod(reported)) {
      return { passed: false, detail: "comparison period start/end must be valid YYYY-MM-DD windows" };
    }
    const currentDays = dayCount(reportP);
    const priorDays = dayCount(reported);
    if (currentDays !== null && priorDays !== null && currentDays !== priorDays && !request.draft.periodLengthNoted) {
      return {
        passed: false,
        detail: `unequal period lengths (${currentDays} vs ${priorDays} days); note the day-count before attributing timing differences`,
      };
    }
  }
  return {
    passed: true,
    detail: `window ${reportP.start}..${reportP.end} matches the retained source report`,
  };
}

function sourceCitationClaim(request: FinanceAnalysisRequest): { passed: boolean; detail: string } {
  if (request.draft.figures.length === 0) {
    return { passed: false, detail: "at least one cited figure is required" };
  }
  for (const fig of request.draft.figures) {
    if (!fig.sourceReportId || !fig.sourceLineId) {
      return { passed: false, detail: `figure "${fig.label}" is missing a source citation` };
    }
    if (fig.sourceReportId !== request.report.reportId) {
      return { passed: false, detail: `figure "${fig.label}" cites unknown report ${fig.sourceReportId}` };
    }
    const line = request.report.lines.find((l) => l.lineId === fig.sourceLineId);
    if (!line) {
      return { passed: false, detail: `figure "${fig.label}" cites missing line ${fig.sourceLineId}` };
    }
    const expected =
      fig.field === "current" ? line.current : fig.field === "prior" ? line.prior : line.current - line.prior;
    if (fig.value !== expected) {
      return {
        passed: false,
        detail: `figure "${fig.label}" value ${fig.value} != ${fig.field} ${expected} on ${fig.sourceLineId}`,
      };
    }
  }
  return { passed: true, detail: `${request.draft.figures.length} figure(s) cited against ${request.report.reportId}` };
}

function parseIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

function validPeriod(p: AccountingPeriod): boolean {
  const a = parseIsoDate(p.start);
  const b = parseIsoDate(p.end);
  return a !== null && b !== null && b >= a;
}

function dayCount(p: AccountingPeriod): number | null {
  const a = parseIsoDate(p.start);
  const b = parseIsoDate(p.end);
  if (!a || !b || b < a) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}
