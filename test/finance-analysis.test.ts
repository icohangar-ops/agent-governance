import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditLedger,
  FinanceAnalysisGate,
  defaultFinanceAnalysisPolicy,
  syntheticXeroPnlExport,
  syntheticXeroCommentaryDraft,
  hashSourceReport,
  isWriteTool,
  WRITE_TOOLS,
  verifyLedger,
  type AuditRecord,
  type CommentaryDraft,
  type FinanceAnalysisRequest,
  type SourceReport,
} from "../src/index.js";

const KEY = "finance-analysis-test-key";

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finance-analysis-"));
  ledgerPath = join(dir, "audit.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gate(): FinanceAnalysisGate {
  return new FinanceAnalysisGate({
    ledger: new AuditLedger({ path: ledgerPath, key: KEY }),
    actor: "finance-bot",
    reviewerPool: ["controller@example.com", "cfo@example.com"],
  });
}

function prepareHappyPath(g: FinanceAnalysisGate): {
  report: SourceReport;
  draft: CommentaryDraft;
  request: FinanceAnalysisRequest;
} {
  const report = syntheticXeroPnlExport();
  const draft = syntheticXeroCommentaryDraft();
  const evidence = g.retainEvidence(report);
  const sealed = g.sealDraft(draft);
  return {
    report,
    draft,
    request: {
      action: "analyze",
      report,
      draft,
      connectorTool: "read-report",
      draftSig: sealed.sig,
      evidenceSig: evidence.sig,
      confidence: 0.9,
    },
  };
}

describe("defaultFinanceAnalysisPolicy", () => {
  test("is analysis-only: zero notional, HITL on every draft, no write verbs", () => {
    const p = defaultFinanceAnalysisPolicy();
    assert.equal(p.maxNotionalUsd, 0);
    assert.equal(p.hitlThresholdUsd, 0);
    assert.deepEqual(p.allowedActions, ["analyze", "comment"]);
    assert.ok(p.allowedVenues?.includes("xero-export"));
    assert.ok(p.allowedAssets?.includes("pnl"));
    for (const write of WRITE_TOOLS) {
      assert.equal(p.allowedActions.includes(write), false);
      assert.equal(isWriteTool(write), true);
    }
  });
});

describe("synthetic Xero fixture", () => {
  test("hashes stably and encodes the 31-vs-28-day comparison trap", () => {
    const a = syntheticXeroPnlExport();
    const b = syntheticXeroPnlExport();
    assert.equal(a.contentHash, b.contentHash);
    assert.equal(a.contentHash, hashSourceReport(a));
    assert.equal(a.period.start, "2026-03-01");
    assert.equal(a.period.end, "2026-03-31");
    assert.deepEqual(a.comparisonPeriod, { start: "2026-02-01", end: "2026-02-28" });
    assert.equal(a.classification, "confidential");
    assert.equal(a.connectorMode, "read-only");
    const np = a.lines.find((l) => l.lineId === "l-np");
    assert.equal(np?.current, 46_000);
    assert.equal(np?.prior, 37_000);
  });
});

describe("FinanceAnalysisGate — happy path (CHP + HITL + ledger)", () => {
  test("cited, period-checked draft goes HITL, then LOCKED after assigned reviewer", () => {
    const g = gate();
    const { request } = prepareHappyPath(g);

    const pending = g.evaluate(request);
    assert.equal(pending.state, "HITL_REQUIRED");
    assert.equal(pending.allowed, false);
    assert.equal(pending.requiresHuman, true);
    assert.ok(pending.provenance.claims.every((c) => c.passed));
    const rules = pending.provenance.claims.map((c) => c.rule);
    for (const rule of [
      "allowed-action",
      "source-citation",
      "period-window",
      "signed-draft",
      "evidence-retained",
      "connector-read-only",
      "classification-ingest",
    ]) {
      assert.ok(rules.includes(rule), `missing claim ${rule}`);
    }

    g.assignReviewer(pending.provenance.decisionId, "controller@example.com");
    assert.equal(g.getAssignedReviewer(pending.provenance.decisionId), "controller@example.com");

    const approved = g.approveCommentary(pending.provenance.decisionId, "controller@example.com");
    assert.equal(approved.state, "LOCKED");
    assert.equal(approved.allowed, true);
    assert.match(approved.reason, /controller@example.com/);

    const verified = verifyLedger(ledgerPath, KEY);
    assert.equal(verified.ok, true);
    const records = readFileSync(ledgerPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as AuditRecord);
    assert.ok(records.some((r) => r.event === "finance.evidence.retained"));
    assert.ok(records.some((r) => r.event === "finance.draft.sealed"));
    assert.ok(records.some((r) => r.event === "finance.reviewer.assigned"));
    assert.ok(records.some((r) => r.event === "chp.hitl_required"));
    assert.ok(records.some((r) => r.event === "chp.locked"));
  });

  test("wrong approver is rejected; reviewer must be assigned first", () => {
    const g = gate();
    const { request } = prepareHappyPath(g);
    const pending = g.evaluate(request);
    assert.throws(
      () => g.approveCommentary(pending.provenance.decisionId, "controller@example.com"),
      /no reviewer assigned/,
    );
    g.assignReviewer(pending.provenance.decisionId, "controller@example.com");
    assert.throws(
      () => g.approveCommentary(pending.provenance.decisionId, "cfo@example.com"),
      /not the assigned reviewer/,
    );
    assert.throws(
      () => g.assignReviewer(pending.provenance.decisionId, "intern@example.com"),
      /not in the reviewer pool/,
    );
  });
});

describe("FinanceAnalysisGate — negative tests", () => {
  test("blocks a draft with a missing citation", () => {
    const g = gate();
    const report = syntheticXeroPnlExport();
    const draft: CommentaryDraft = {
      ...syntheticXeroCommentaryDraft(),
      figures: [
        { label: "Net Profit", value: 46_000, sourceReportId: "", sourceLineId: "", field: "current" },
      ],
    };
    g.retainEvidence(report);
    const sealed = g.sealDraft(draft);
    const d = g.evaluate({
      action: "analyze",
      report,
      draft,
      connectorTool: "read-report",
      draftSig: sealed.sig,
    });
    assert.equal(d.state, "BLOCKED");
    assert.match(d.reason, /source-citation/);
    const cite = d.provenance.claims.find((c) => c.rule === "source-citation");
    assert.equal(cite?.passed, false);
    assert.match(cite?.detail ?? "", /missing a source citation/);
  });

  test("blocks a period mismatch (commentary window != source report)", () => {
    const g = gate();
    const report = syntheticXeroPnlExport();
    const draft: CommentaryDraft = {
      ...syntheticXeroCommentaryDraft(),
      period: { start: "2026-01-01", end: "2026-03-31" }, // YTD claimed against a March report
    };
    g.retainEvidence(report);
    const sealed = g.sealDraft(draft);
    const d = g.evaluate({
      action: "analyze",
      report,
      draft,
      connectorTool: "read-report",
      draftSig: sealed.sig,
    });
    assert.equal(d.state, "BLOCKED");
    assert.match(d.reason, /period-window/);
    const period = d.provenance.claims.find((c) => c.rule === "period-window");
    assert.equal(period?.passed, false);
    assert.match(period?.detail ?? "", /2026-01-01\.\.2026-03-31 != report 2026-03-01\.\.2026-03-31/);
  });

  test("blocks an un-noted 31-vs-28-day comparison (timing overstatement)", () => {
    const g = gate();
    const report = syntheticXeroPnlExport();
    const { periodLengthNoted: _drop, ...rest } = syntheticXeroCommentaryDraft();
    const draft: CommentaryDraft = rest;
    g.retainEvidence(report);
    const sealed = g.sealDraft(draft);
    const d = g.evaluate({
      action: "analyze",
      report,
      draft,
      connectorTool: "read-report",
      draftSig: sealed.sig,
    });
    assert.equal(d.state, "BLOCKED");
    assert.match(d.reason, /period-window/);
    const period = d.provenance.claims.find((c) => c.rule === "period-window");
    assert.match(period?.detail ?? "", /unequal period lengths \(31 vs 28 days\)/);
  });

  test("blocks mutate-ledger / write tools at the claim layer and CHP allowlist", () => {
    const g = gate();
    const { request } = prepareHappyPath(g);
    const d = g.evaluate({
      ...request,
      action: "mutate-ledger",
      connectorTool: "post-journal",
    });
    assert.equal(d.state, "BLOCKED");
    const failed = d.provenance.claims.filter((c) => !c.passed).map((c) => c.rule);
    assert.ok(failed.includes("allowed-action"));
    assert.ok(failed.includes("connector-read-only"));
    assert.equal(g.getChpGate().getDailyNotionalUsd(), 0);
  });

  test("invokeConnectorWrite and mutateLedger are hard-denied", () => {
    const g = gate();
    assert.throws(() => g.mutateLedger(), /ledger mutation is denied/);
    assert.throws(() => g.invokeConnectorWrite("post-journal"), /post-journal is denied/);
  });

  test("rejects an unsigned draft", () => {
    const g = gate();
    const report = syntheticXeroPnlExport();
    const draft = syntheticXeroCommentaryDraft();
    g.retainEvidence(report);
    // sealDraft is deliberately skipped
    const d = g.evaluate({
      action: "analyze",
      report,
      draft,
      connectorTool: "read-report",
    });
    assert.equal(d.state, "BLOCKED");
    assert.match(d.reason, /signed-draft/);
    const signed = d.provenance.claims.find((c) => c.rule === "signed-draft");
    assert.equal(signed?.passed, false);
    assert.match(signed?.detail ?? "", /unsigned draft rejected/);
  });

  test("rejects a sealed draft that was mutated after signing", () => {
    const g = gate();
    const report = syntheticXeroPnlExport();
    const draft = syntheticXeroCommentaryDraft();
    g.retainEvidence(report);
    const sealed = g.sealDraft(draft);
    const mutated: CommentaryDraft = { ...draft, commentary: draft.commentary + " (edited)" };
    const d = g.evaluate({
      action: "analyze",
      report,
      draft: mutated,
      connectorTool: "read-report",
      draftSig: sealed.sig,
    });
    assert.equal(d.state, "BLOCKED");
    assert.match(d.reason, /signed-draft/);
    const signed = d.provenance.claims.find((c) => c.rule === "signed-draft");
    assert.match(signed?.detail ?? "", /mutated or forged/);
  });

  test("blocks restricted-field leakage", () => {
    const g = gate();
    const report: SourceReport = {
      ...syntheticXeroPnlExport(),
      restrictedFields: ["bankAccountNumber"],
    };
    report.contentHash = hashSourceReport(report);
    const draft = syntheticXeroCommentaryDraft();
    g.retainEvidence(report);
    const sealed = g.sealDraft(draft);
    const d = g.evaluate({
      action: "analyze",
      report,
      draft,
      connectorTool: "read-report",
      draftSig: sealed.sig,
    });
    assert.equal(d.state, "BLOCKED");
    assert.match(d.reason, /classification-ingest/);
  });

  test("blocks when the source report was never retained", () => {
    const g = gate();
    const report = syntheticXeroPnlExport();
    const draft = syntheticXeroCommentaryDraft();
    const sealed = g.sealDraft(draft);
    const d = g.evaluate({
      action: "analyze",
      report,
      draft,
      connectorTool: "read-report",
      draftSig: sealed.sig,
    });
    assert.equal(d.state, "BLOCKED");
    assert.match(d.reason, /evidence-retained/);
  });
});
