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
| `evaluate(action)` | Run policy + adversarial checks. Returns `ChpDecision` (`allowed`, `requiresHuman`, `state`, `reason`, `provenance`). |
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

### Ledger (`AuditLedger`)

| Export | Description |
| --- | --- |
| `new AuditLedger({ path, key?, lock?, lockTimeoutMs?, lockRetryMs?, lockStaleMs? })` | Signed append-only JSONL ledger. Key defaults to `$AUDIT_LEDGER_KEY`, then a documented dev-only default. |
| `append(record)` | Append one record chained to the previous signature; returns the new signature. |
| `verify()` / `verifyLedger(path, key?)` | Re-derive every signature in-chain; reports the first tampered line index. |
| `canonicalJson(value)` | Stable sorted-key JSON used as the signing payload. |

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
