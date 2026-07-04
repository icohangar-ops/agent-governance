# Provenance (internal — not shipped in the npm package)

`@cubiczan/agent-governance` is a unified, hardened superset of governance
code originally written by Shyam Desigan (Cubiczan) and published across
several of the author's own repositories. The author is the sole copyright
holder of all donor code and relicenses it here under the proprietary
commercial license in LICENSE.md. No third-party code is included; the
package has zero runtime dependencies (Node built-ins only).

## Donor sources

| Donor | Path | What was taken |
| --- | --- | --- |
| cognitrader-bsc | `src/chp/policy.ts`, `src/chp/gate.ts`, `policy.yaml` | CHP gate states, adversarial checks, flat-YAML policy loader |
| deepbook-trading-agent | `src/chp/policy.ts`, `src/chp/gate.ts`, `config/policy.yaml` | zero-notional ("unsized") semantics, `{}` inline map parsing |
| vaultmind (vaultmind-sdk) | `src/chp/policy.ts`, `src/chp/gate.ts`, `config/policy.yaml` | policy loader variant, per-token caps |
| cubiczan-resilience | `typescript/src/auditLedger.ts`, `typescript/test/auditLedger.test.ts` | HMAC-SHA256 chained JSONL AuditLedger + golden-vector test (signing scheme kept byte-identical) |
| cleanmandate (Rust, semantics reference) | `policies/mandate.yaml`, CHP crates | asset/chain/recipient allowlist semantics |
| swarmfi-executor (Rust, semantics reference) | `policies/executor.yaml`, `crates/sfe-policy` | venue allowlists, blocked assets, max leverage, `require_human_above` |

## New in this package (not in any public donor)

- One canonical `Policy` superset schema (allowlists, blocklist, venues,
  leverage, price band) with plain-object construction + validation.
- Gate decisions auto-append to a pluggable signed `AuditLedger`.
- File-backed persistence of the rolling daily notional cap (`statePath`).
- Advisory lockfile + O_APPEND multi-process append safety for the ledger.
- Policy hot-reload with strict validation (`reloadPolicy` / `watchPolicy`).
- Typed event hooks (`onBlocked` / `onHitl` / `onLocked`).

## Compatibility guarantees

The ledger signing scheme (canonical JSON, signing payload field set, HMAC
key resolution, `prev_sig` chaining) is byte-identical to the
cubiczan-resilience TS/Python/Rust ports and is pinned by the shared
cross-language golden vector:

```
d379966f5be33822aa1091efa18034e67e679fbadb168bb73c3f42ef712a46fc
```

Ledgers written by any of those implementations verify under this package
(same key), and vice versa.
