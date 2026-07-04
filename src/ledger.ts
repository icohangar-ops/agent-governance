/**
 * @cubiczan/agent-governance — signed, append-only JSONL audit ledger.
 *
 * Ported from the author's cubiczan-resilience TypeScript AuditLedger, which
 * generalizes the HMAC-SHA256 audit ledgers in cleanmandate, swarmfi-executor,
 * glacier-edge-arm, and compliance-as-code-agent. Every record signs the
 * *previous* record's signature, so the ledger is tamper-evident and truly
 * append-only — you cannot edit, reorder, or delete an interior line without
 * breaking every signature that follows it.
 *
 * Signing scheme (byte-identical across the TS / Python / Rust ports — do NOT
 * change; guarded by the cross-language golden vector d379966f…):
 *
 *   canonical = canonicalJson({ ts, event, actor, inputs, sources,
 *                               confidence?, rationale?, prev_sig })
 *   sig       = hex( HMAC-SHA256(key, canonical) )
 *
 * `canonicalJson` emits object keys in sorted order with no insignificant
 * whitespace, so the signed bytes are stable regardless of insertion order.
 * The genesis record uses `prev_sig = ""`.
 *
 * Hardening over the public donor (multi-process append safety):
 *
 *   - Appends are serialized through an advisory lockfile (`<path>.lock`,
 *     created with O_CREAT|O_EXCL) with bounded retry and stale-lock
 *     reclamation. While holding the lock the writer re-reads the chain tail
 *     so concurrent processes stay chained correctly.
 *   - The write itself uses O_APPEND (fs `"a"` flag), which is atomic for
 *     records well under the pipe buffer size on local POSIX filesystems.
 *
 *   Limits: the lock is advisory (cooperating writers only) and stale-lock
 *   reclamation relies on mtime, so it is NOT safe on filesystems without
 *   coherent metadata (e.g. NFS). For multi-host writers, front the ledger
 *   with a single writer process.
 */

import { createHmac } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * The default signing key. Documented and safe ONLY for tests/dev. Kept
 * byte-identical to the cubiczan-resilience donors so default-keyed ledgers
 * remain verifiable across the TS / Python / Rust implementations.
 */
export const DEFAULT_AUDIT_LEDGER_KEY =
  "cubiczan-resilience-insecure-default-key";

/** The environment variable read for the signing key. */
export const AUDIT_LEDGER_KEY_ENV = "AUDIT_LEDGER_KEY";

/** Caller-supplied fields of an audit record. */
export interface AuditRecordInput {
  /** What happened (a decision / event name). */
  readonly event: string;
  /** Who/what performed it (agent, user, service). */
  readonly actor: string;
  /** The inputs the decision was made from. */
  readonly inputs?: unknown;
  /** Provenance: where the inputs/evidence came from. */
  readonly sources?: unknown;
  /** Optional confidence score for the decision. */
  readonly confidence?: number;
  /** Optional human-readable rationale. */
  readonly rationale?: string;
  /**
   * RFC 3339 timestamp. Defaults to `new Date().toISOString()`. Supply this to
   * make records deterministic in tests.
   */
  readonly ts?: string;
}

/** A fully materialized, signed ledger record (one JSONL line). */
export interface AuditRecord {
  readonly ts: string;
  readonly event: string;
  readonly actor: string;
  readonly inputs: unknown;
  readonly sources: unknown;
  readonly confidence?: number;
  readonly rationale?: string;
  /** Signature of the prior record (`""` for the genesis record). */
  readonly prev_sig: string;
  /** HMAC-SHA256 over the canonical record including `prev_sig`. */
  readonly sig: string;
}

/** Result of {@link AuditLedger.verify} / {@link verifyLedger}. */
export type VerifyResult =
  | { readonly ok: true; readonly count: number }
  | {
      readonly ok: false;
      /** Zero-based index of the first line that fails verification. */
      readonly tamperedIndex: number;
      readonly reason: string;
    };

/** Thrown when the append lock cannot be acquired within the timeout. */
export class LedgerLockError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`could not acquire ledger lock ${lockPath} within ${timeoutMs}ms`);
    this.name = "LedgerLockError";
  }
}

export interface AuditLedgerOptions {
  /** Path to the JSONL ledger file. */
  readonly path: string;
  /**
   * HMAC key. Defaults to `process.env.AUDIT_LEDGER_KEY`, then to
   * {@link DEFAULT_AUDIT_LEDGER_KEY} (test-only).
   */
  readonly key?: string;
  /**
   * Serialize appends through an advisory `<path>.lock` file so multiple
   * cooperating processes can share one ledger. Default true.
   */
  readonly lock?: boolean;
  /** Total time to wait for the lock before throwing. Default 2000ms. */
  readonly lockTimeoutMs?: number;
  /** Delay between lock acquisition attempts. Default 25ms. */
  readonly lockRetryMs?: number;
  /** Age after which a leftover lock is considered stale and reclaimed. Default 10000ms. */
  readonly lockStaleMs?: number;
}

/** Stable, whitespace-free JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function resolveKey(key?: string): string {
  return key ?? process.env[AUDIT_LEDGER_KEY_ENV] ?? DEFAULT_AUDIT_LEDGER_KEY;
}

/**
 * The exact bytes that get signed for a record. Only the content fields plus
 * `prev_sig` are covered — never `sig` itself. Optional fields are omitted when
 * absent so the canonical form matches on both append and verify.
 */
function signingPayload(
  rec: Omit<AuditRecord, "sig">,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ts: rec.ts,
    event: rec.event,
    actor: rec.actor,
    inputs: rec.inputs,
    sources: rec.sources,
    prev_sig: rec.prev_sig,
  };
  if (rec.confidence !== undefined) payload.confidence = rec.confidence;
  if (rec.rationale !== undefined) payload.rationale = rec.rationale;
  return payload;
}

function sign(key: string, rec: Omit<AuditRecord, "sig">): string {
  return createHmac("sha256", key)
    .update(canonicalJson(signingPayload(rec)))
    .digest("hex");
}

function parseLines(raw: string): AuditRecord[] {
  const records: AuditRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    records.push(JSON.parse(line) as AuditRecord);
  }
  return records;
}

function lastSigOnDisk(path: string): string {
  if (!existsSync(path)) return "";
  const records = parseLines(readFileSync(path, "utf-8"));
  return records.at(-1)?.sig ?? "";
}

/** Synchronous sleep without spinning (Node main thread supports Atomics.wait). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * File-backed, HMAC-signed, append-only JSONL audit ledger with per-record
 * signature chaining and (optional, on by default) multi-process append
 * locking.
 */
export class AuditLedger {
  private readonly path: string;
  private readonly key: string;
  private readonly lock: boolean;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;
  /** Signature of the last appended record; seeds the next `prev_sig`. */
  private lastSig: string;

  constructor(options: AuditLedgerOptions) {
    this.path = options.path;
    this.key = resolveKey(options.key);
    this.lock = options.lock ?? true;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2000;
    this.lockRetryMs = options.lockRetryMs ?? 25;
    this.lockStaleMs = options.lockStaleMs ?? 10_000;
    // Resume the chain from an existing file so appends stay linked.
    this.lastSig = lastSigOnDisk(this.path);
  }

  /**
   * Append one record, chaining it to the previous line's signature, and
   * return the new record's signature.
   *
   * With locking enabled (default) the append is serialized through
   * `<path>.lock` and the chain tail is re-read under the lock, so multiple
   * cooperating processes can append to the same ledger without forking the
   * chain. Throws {@link LedgerLockError} if the lock cannot be acquired.
   */
  append(input: AuditRecordInput): string {
    if (!this.lock) return this.appendUnlocked(input);
    const lockPath = `${this.path}.lock`;
    this.acquireLock(lockPath);
    try {
      // Another process may have appended while we waited: re-sync the tail.
      this.lastSig = lastSigOnDisk(this.path);
      return this.appendUnlocked(input);
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        /* lock already reclaimed — nothing to release */
      }
    }
  }

  /**
   * Re-walk the whole ledger and recompute every signature in-chain. Verifies
   * with the same key used to construct this instance.
   */
  verify(): VerifyResult {
    return verifyLedger(this.path, this.key);
  }

  // ── Internals ──────────────────────────────────────────────

  private appendUnlocked(input: AuditRecordInput): string {
    const unsigned: Omit<AuditRecord, "sig"> = {
      ts: input.ts ?? new Date().toISOString(),
      event: input.event,
      actor: input.actor,
      inputs: input.inputs ?? null,
      sources: input.sources ?? null,
      ...(input.confidence !== undefined
        ? { confidence: input.confidence }
        : {}),
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      prev_sig: this.lastSig,
    };
    const sig = sign(this.key, unsigned);
    const record: AuditRecord = { ...unsigned, sig };

    const dir = dirname(this.path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    // "a" => O_APPEND: the kernel appends the whole line atomically for
    // records well under PIPE_BUF-scale sizes on local POSIX filesystems.
    appendFileSync(this.path, JSON.stringify(record) + "\n");

    this.lastSig = sig;
    return sig;
  }

  private acquireLock(lockPath: string): void {
    const dir = dirname(this.path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    const start = Date.now();
    for (;;) {
      try {
        const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL | O_WRONLY
        try {
          writeSync(fd, `${process.pid}\n`);
        } finally {
          closeSync(fd);
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Reclaim a stale lock left by a crashed writer.
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > this.lockStaleMs) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue; // lock vanished between attempts — retry immediately
        }
        if (Date.now() - start >= this.lockTimeoutMs) {
          throw new LedgerLockError(lockPath, this.lockTimeoutMs);
        }
        sleepSync(this.lockRetryMs);
      }
    }
  }
}

/**
 * Verify a ledger file without constructing an {@link AuditLedger}. Re-derives
 * each signature from the stored content + the running `prev_sig` and returns
 * the index of the first line whose signature or chain link is broken.
 */
export function verifyLedger(path: string, key?: string): VerifyResult {
  const resolvedKey = resolveKey(key);
  const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const records = parseLines(raw);

  let prevSig = "";
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] as AuditRecord;
    if (rec.prev_sig !== prevSig) {
      return {
        ok: false,
        tamperedIndex: i,
        reason: `prev_sig mismatch: chain broken at line ${i}`,
      };
    }
    const { sig, ...unsigned } = rec;
    const expected = sign(resolvedKey, unsigned);
    if (expected !== sig) {
      return {
        ok: false,
        tamperedIndex: i,
        reason: `signature mismatch at line ${i}`,
      };
    }
    prevSig = sig;
  }
  return { ok: true, count: records.length };
}
