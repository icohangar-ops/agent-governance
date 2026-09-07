# @cubiczan/agent-governance

**Governance and audit layer for AI agents that move capital.**

Every capital-moving action an agent proposes is driven through a policy
gate (`EXPLORING → PROVISIONAL → LOCKED / HITL_REQUIRED / BLOCKED`), checked
against hard risk limits and adversarial sanity rules, and recorded in a
tamper-evident, HMAC-signed, append-only audit ledger — so you can prove to
an auditor, a counterparty, or yourself exactly what the agent did and why.

- **Zero runtime dependencies.** Node built-ins only.
- **Fail-closed by design.** Unknown actions, missing policies, breached
  caps, low-confidence signals, and unauditable decisions never execute.
- **Restart- and multi-process-safe.** Daily caps persist across restarts;
  ledger appends are lockfile-serialized across processes.
- **Finance-analysis adapter.** Variance commentary over exported reports
  (Xero-style) is analysis-only: classification tiers, required citations,
  period-window checks, assigned HITL reviewers, and immutable signed drafts.
- **Domain-event cookbook.** Entities raise facts with no `UserId`; an
  application handler attaches the actor and appends to the same HMAC
  JSONL ledger (`prev_sig` chain). Capital-moving events still go through
  `ChpGate` / HITL.

UiPath handoffs can be normalized into governed action envelopes before a capital-moving decision is allowed through the gate.

This is a commercial, proprietary package. See [LICENSE.md](./LICENSE.md).
Contact sam@cubiczan.com for licensing.

## Quickstart

```ts
import { ChpGate, AuditLedger, createPolicy } from "@cubiczan/agent-governance";

const ledger = new AuditLedger({
  path: "var/audit.jsonl",
  key: process.env.AUDIT_LEDGER_KEY, // HMAC-SHA256 signing key
});

const gate = new ChpGate({
  policy: createPolicy({
    version: "1.0",
    maxNotionalUsd: 5000,
    dailyNotionalCapUsd: 20000,
    hitlThresholdUsd: 1000,
    allowedActions: ["buy", "sell"],
    perAssetLimits: { ETH: 5000, SOL: 3000 },
    minConfidence: 0.5,
    allowedVenues: ["hyperliquid", "polymarket"],
    maxLeverage: 5,
  }),
  ledger,                          // every decision is signed into the ledger
  statePath: "var/chp-daily.json", // daily cap survives restarts
  hooks: {
    onBlocked: (d) => alertDashboard(d),
    onHitl: (d) => pageHuman(d),
  },
});

const decision = gate.evaluate({
  action: "buy",
  asset: "ETH",
  notionalUsd: 750,
  venue: "hyperliquid",
  confidence: 0.82,
  rationale: "momentum breakout",
});

if (decision.allowed) {
  await execute(order);
} else if (decision.requiresHuman) {
  // later, after a human signs off:
  gate.approveHuman(decision.provenance.decisionId, "sam@cubiczan.com");
}

// Anyone with the key can independently verify the whole ledger:
console.log(ledger.verify()); // { ok: true, count: n }
```

Or load the policy from a flat YAML file (zero-dependency parser):

```ts
const gate = new ChpGate({ policyPath: "config/policy.yaml", ledger });
gate.watchPolicy(5000); // hot-reload with validation; invalid edits are rejected
```

```yaml
version: "1.0"
max_notional_usd: 5000.0
daily_notional_cap_usd: 20000.0
hitl_threshold_usd: 1000.0
allowed_actions:
  - buy
  - sell
per_asset_limits:
  ETH: 5000.0
  SOL: 3000.0
min_confidence: 0.5
allowed_venues:
  - hyperliquid
max_leverage: 5.0
price_band:
  min: 0.02
  max: 0.98
```

## API

### Policy (`Policy`)

| Export | Description |
| --- | --- |
| `createPolicy(partial)` | Build a policy from a plain object; unspecified fields take the conservative default. Throws `PolicyValidationError` with per-field messages. |
| `validatePolicy(policy)` | Returns a list of human-readable errors (empty = valid). |
| `loadPolicy(path?, { strict?, warn? })` | Load from flat YAML. Non-strict (default): missing/invalid file warns and falls back to the conservative default. Strict: throws. |
| `defaultPolicy()` / `defaultPolicyPath()` | Conservative built-in policy / `config/policy.yaml` under cwd. |

Schema: `maxNotionalUsd`, `dailyNotionalCapUsd`, `hitlThresholdUsd`,
`allowedActions`, `perAssetLimits`, `minConfidence`, plus optional
`allowedAssets`, `blockedAssets`, `allowedVenues`, `maxLeverage`,
`priceBand { min?, max? }`.

### Gate (`ChpGate`)

| Member | Description |
| --- | --- |
| `new ChpGate({ policy?, policyPath?, ledger?, actor?, statePath?, allowZeroNotional?, hooks?, clock? })` | Construct with a validated policy object or a YAML path. |
| `evaluate(action, extraClaims?)` | Run policy + adversarial checks. Optional `extraClaims` from a domain adapter (e.g. finance-analysis) fold into the same provenance and hard-block pipeline. Returns `ChpDecision` (`allowed`, `requiresHuman`, `state`, `reason`, `provenance`). |
| `approveHuman(decisionId, approver)` | Promote a pending HITL decision to LOCKED (hard caps re-checked at approval time). |
| `getPendingHitl()` | Pending HITL actions keyed by decisionId. |
| `getDecisions()` | In-memory append-only provenance records. |
| `getDailyNotionalUsd()` | Notional locked in the current rolling day. |
| `reloadPolicy()` | Strict re-load + validate from `policyPath`; keeps the old policy on failure. |
| `watchPolicy(intervalMs?, onReload?)` / `unwatchPolicy()` | Polling hot-reload (watcher is unref'ed). |
| `on("blocked" \| "hitl" \| "locked", fn)` | Typed event hooks; returns an unsubscribe function. |

Checks run per action: allowed-action, allowed/blocked-asset, allowed-venue,
per-asset cap, max notional, projected daily cap, sane-notional,
min-confidence, max-leverage, price band. Every check is recorded as a
pass/fail claim in the decision's provenance.

### Finance analysis (`FinanceAnalysisGate`)

Analysis-only adapter over `ChpGate` + `AuditLedger`. The policy allows
`analyze` / `comment` only (notional 0, HITL threshold 0). Extra claims —
classification ingest, read-only connector, source citation, period window,
retained evidence, signed draft — run through the same CHP pipeline.

| Member | Description |
| --- | --- |
| `defaultFinanceAnalysisPolicy()` | Analysis-only `Policy` (zero notional, HITL on every draft). |
| `syntheticXeroPnlExport()` | Synthetic Xero-style P&L (March 2026 vs February 2026). |
| `retainEvidence(report)` | Append the source report hash to the ledger. |
| `sealDraft(draft)` | Append an immutable draft record; later edits fail `signed-draft`. |
| `evaluate(request)` | Finance claims + CHP evaluate. Happy path → `HITL_REQUIRED`. |
| `assignReviewer(decisionId, reviewer)` | Bind a pending HITL decision to a named reviewer. |
| `approveCommentary(decisionId, approver)` | Promote to `LOCKED`; approver must be the assigned reviewer. |
| `mutateLedger()` / `invokeConnectorWrite(tool)` | Always throw — write tools are denied. |

Classification tiers (higher = more sensitive): `public` < `internal` <
`confidential` < `restricted`. Restricted fields (bank accounts, payroll PII,
tax IDs) never enter the analysis context. Default max ingest is
`confidential`.

### Ledger (`AuditLedger`)

| Export | Description |
| --- | --- |
| `new AuditLedger({ path, key?, historicKeys?, lock?, lockTimeoutMs?, lockRetryMs?, lockStaleMs? })` | Signed append-only JSONL ledger. Key defaults to `$AUDIT_LEDGER_KEY`, then a documented dev-only default. `historicKeys` are prior secrets accepted by `verify()` after rotation. |
| `append(record)` | Append one record chained to the previous signature; returns the new signature. |
| `rotateKey(nextKey, actor?)` | Append `ledger.key.rotated` with the current key, then sign subsequent lines with `nextKey`. Does not change the HMAC payload or `prev_sig` scheme. |
| `verify()` / `verifyLedger(path, key?)` | Re-derive every signature in-chain; reports the first tampered line index. `key` may be a string or a rotation key-ring (`string[]`). |
| `canonicalJson(value)` | Stable sorted-key JSON used as the signing payload. |

### Domain events (`DomainEventLedgerHandler`, `Order`)

Application-layer adapter over `ChpGate` + `AuditLedger`. Aggregates raise
facts with **no actor / `UserId`**. The handler attaches the current user
(or service) and appends a `domain.<eventType>` line to the same HMAC
JSONL ledger. Capital-moving facts optionally map onto `ChpGate.evaluate`
so HITL and policy still apply.

| Member | Description |
| --- | --- |
| `new DomainEventLedgerHandler({ ledger, actor, gate?, mapToAction? })` | Actor is required; `mapToAction` without a gate is fail-closed. |
| `dispatch(event, actorOverride?)` | Attach actor, append, optionally evaluate CHP. Rejects events that leaked `actor` / `userId` / `UserId`. |
| `dispatchAll(events, actorOverride?)` | Drain-and-dispatch helper for `order.pullDomainEvents()`. |
| `approveHuman(decisionId, approver)` | Promote a HITL-gated capital-moving event. |
| `Order.open / cancel / fill` | Cookbook aggregate — no `UserId` on the entity. |
| `Order.fromEvents(events)` | Replay entity state from verified `domain.*` lines. |
| `defaultDomainEventOrderPolicy()` | Cookbook policy (`buy`/`sell`, HITL at $1000). |
| `mapOrderEventToAction(event)` | `order.opened` → `buy`; cancel / fill skip the gate. |
| `domainEventsFromRecords(records)` | Extract domain facts from a verified ledger (skips CHP / rotation lines). |

## Cookbook: Xero-export variance commentary

Finance teams export a P&L (or similar) from Xero and ask a model for
variance commentary. The model must not invent figures, mis-state the
reporting window, or treat a 31-day March vs 28-day February lift as a
pure run-rate improvement. The connector is **read-only**: the agent
never posts journals or rewrites the audit ledger.

Synthetic fixture (also at [`examples/xero-pnl-export.json`](./examples/xero-pnl-export.json);
numbers are invented, not a real entity):

```json
{
  "reportId": "xero-pnl-northwind-2026-03",
  "connector": "xero-export",
  "connectorMode": "read-only",
  "reportName": "Profit and Loss",
  "period": { "start": "2026-03-01", "end": "2026-03-31" },
  "comparisonPeriod": { "start": "2026-02-01", "end": "2026-02-28" },
  "classification": "confidential",
  "restrictedFields": [],
  "lines": [
    { "lineId": "l-np", "accountCode": "NP", "accountName": "Net Profit", "current": 46000, "prior": 37000 }
  ]
}
```

```ts
import {
  AuditLedger,
  FinanceAnalysisGate,
  syntheticXeroPnlExport,
  syntheticXeroCommentaryDraft,
} from "@cubiczan/agent-governance";

const ledger = new AuditLedger({ path: "var/finance-audit.jsonl" });
const finance = new FinanceAnalysisGate({
  ledger,
  reviewerPool: ["controller@example.com"],
});

const report = syntheticXeroPnlExport();
const draft = syntheticXeroCommentaryDraft();
// draft.periodLengthNoted === true  → 31-vs-28-day comparison is acknowledged

const evidence = finance.retainEvidence(report); // source report stays on the ledger
const sealed = finance.sealDraft(draft);         // immutable; edits need a new seal

const decision = finance.evaluate({
  action: "analyze",           // "post-journal" / "mutate-ledger" → BLOCKED
  report,
  draft,
  connectorTool: "read-report",
  draftSig: sealed.sig,        // omit this → unsigned draft rejected
  evidenceSig: evidence.sig,
});

if (decision.requiresHuman) {
  finance.assignReviewer(decision.provenance.decisionId, "controller@example.com");
  finance.approveCommentary(decision.provenance.decisionId, "controller@example.com");
}

ledger.verify(); // { ok: true, count: n }
```

The matching analysis-only policy lives at
[`examples/finance-analysis-policy.yaml`](./examples/finance-analysis-policy.yaml)
(`allowed_actions: analyze, comment`; all notionals 0).

## Cookbook: Domain events → HMAC ledger

The EF / DDD instinct is to stamp `UserId` (or `CreatedBy`) on every
entity so the database *is* the audit trail. That pollutes the aggregate,
couples persistence to identity, and still is not tamper-evident.

Use **domain events** when an aggregate owns the facts and must stay
persistence-pure. The entity raises `order.opened` / `order.cancelled`
with no actor. After the application knows who is calling (HTTP user,
agent id, service identity), `DomainEventLedgerHandler` attaches that
actor and appends to the existing HMAC JSONL ledger — same
`canonicalJson` + HMAC-SHA256 + `prev_sig` chain as CHP and
finance-analysis. Do not invent a second hash scheme.

Use **direct ledger writes** (`ledger.append`, or the writes
`ChpGate` / `FinanceAnalysisGate` already make) when you are already in
the application / governance layer and there is no entity raising an
event. Wrapping those decisions in a fake domain event is theater.

A capital-moving domain event may produce *two* chained lines on
purpose: `domain.order.opened` (the fact + actor) then `chp.locked` /
`chp.hitl_required` (the governance decision). Replay reads only
`domain.*` lines; `verify()` covers the whole file.

Synthetic fixture (also at
[`examples/domain-event-order.json`](./examples/domain-event-order.json);
not a real venue fill):

```json
{
  "eventId": "evt-ord-northwind-eth-001-opened",
  "eventType": "order.opened",
  "occurredAt": "2026-09-07T00:00:00.000Z",
  "aggregateType": "Order",
  "aggregateId": "ord-northwind-eth-001",
  "payload": { "asset": "ETH", "qty": 1.5, "notionalUsd": 750, "venue": "hyperliquid" }
}
```

```ts
import {
  AuditLedger,
  ChpGate,
  DomainEventLedgerHandler,
  Order,
  defaultDomainEventOrderPolicy,
  domainEventsFromRecords,
  mapOrderEventToAction,
  verifyLedger,
} from "@cubiczan/agent-governance";

const ledger = new AuditLedger({ path: "var/audit.jsonl", key: process.env.AUDIT_LEDGER_KEY });
const gate = new ChpGate({
  policy: defaultDomainEventOrderPolicy(),
  ledger,                 // same sink the handler writes to
  actor: "chp-gate",
});
const handler = new DomainEventLedgerHandler({
  ledger,
  actor: "sam@cubiczan.com", // attached here — never stored on Order
  gate,
  mapToAction: mapOrderEventToAction,
});

const order = Order.open({
  orderId: "ord-northwind-eth-001",
  asset: "ETH",
  qty: 1.5,
  notionalUsd: 750,       // under the $1000 HITL threshold → LOCKED
  venue: "hyperliquid",
});
// order has no UserId; pullDomainEvents() returns facts only

const [opened] = handler.dispatchAll(order.pullDomainEvents());
if (opened.decision?.requiresHuman) {
  handler.approveHuman(opened.decision.provenance.decisionId, "risk@example.com");
}

ledger.verify(); // { ok: true, count: n } — includes domain.* + chp.*

// Replay: rehydrate the aggregate from verified domain lines (skip CHP).
const events = domainEventsFromRecords(/* read JSONL records */);
const replayed = Order.fromEvents(events);
```

The matching policy lives at
[`examples/domain-event-order-policy.yaml`](./examples/domain-event-order-policy.yaml).

Key rotation uses the same chain. `rotateKey` appends
`ledger.key.rotated` with the old secret; later lines use the new one.
`verifyLedger(path, [oldKey, newKey])` (or `historicKeys` on a
reconstructed `AuditLedger`) walks the file. A single key will fail
across the cutover — that is the point.

Multi-writer: cooperating processes share the ledger via the existing
`<path>.lock` + tail re-read. Do not bypass the lock; see
[Multi-process ledger safety](#multi-process-ledger-safety--limits).

Negative paths the gate records as `BLOCKED` claims:

| Failure | Claim |
| --- | --- |
| Figure without `sourceReportId` / `sourceLineId`, or value ≠ source line | `source-citation` |
| Draft window ≠ report window, or un-noted unequal day-counts | `period-window` |
| `post-journal`, `mutate-ledger`, or any write tool | `connector-read-only` + `allowed-action` |
| `sealDraft` skipped, or draft edited after sealing | `signed-draft` |
| Restricted fields still on the export | `classification-ingest` |
| Source report never passed to `retainEvidence` | `evidence-retained` |

## Cross-language golden-vector compatibility

The signing scheme (canonical JSON, payload field set, HMAC-SHA256,
`prev_sig` chaining) is byte-identical to the author's TypeScript, Python,
and Rust audit-ledger implementations, pinned by a shared golden vector
asserted in this package's test suite:

```
key="k", ts="2026-01-01T00:00:00Z", event="e", actor="a", inputs={x:1}, sources=["s"]
sig = d379966f5be33822aa1091efa18034e67e679fbadb168bb73c3f42ef712a46fc
```

Ledgers written by any of those implementations verify under this package
(with the same key), and vice versa.

## Multi-process ledger safety — limits

Appends are serialized via an advisory `<path>.lock` file (O_CREAT|O_EXCL,
bounded retry, mtime-based stale-lock reclamation) and written with
O_APPEND. This is safe for cooperating writers on a local POSIX filesystem.
It is **not** safe on NFS or other filesystems without coherent metadata,
and it does not protect against non-cooperating writers that bypass the
lock. For multi-host deployments, front the ledger with a single writer.

## License

Proprietary. Copyright (c) 2026 Shyam Desigan (Cubiczan). All rights
reserved. Use requires a commercial license — sam@cubiczan.com.
