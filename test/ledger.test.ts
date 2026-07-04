import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditLedger,
  verifyLedger,
  LedgerLockError,
  DEFAULT_AUDIT_LEDGER_KEY,
  type AuditRecord,
} from "../src/ledger.js";

const KEY = "test-key-0123456789";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-ledger-"));
  path = join(dir, "audit.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readRecords(p: string): AuditRecord[] {
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe("AuditLedger append + verify", () => {
  test("appends N records and verify passes", () => {
    const ledger = new AuditLedger({ path, key: KEY });
    for (let i = 0; i < 5; i++) {
      ledger.append({
        event: "decision",
        actor: "agent-1",
        inputs: { i },
        sources: ["src-a"],
        confidence: 0.9,
        rationale: `step ${i}`,
      });
    }
    const result = ledger.verify();
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 5);
  });

  test("chains each record to the prior signature", () => {
    const ledger = new AuditLedger({ path, key: KEY });
    const s0 = ledger.append({ event: "e0", actor: "a" });
    const s1 = ledger.append({ event: "e1", actor: "a" });

    const recs = readRecords(path);
    assert.equal(recs[0]!.prev_sig, ""); // genesis
    assert.equal(recs[0]!.sig, s0);
    assert.equal(recs[1]!.prev_sig, s0); // links to prior sig
    assert.equal(recs[1]!.sig, s1);
  });

  test("resumes the chain across instances", () => {
    const l1 = new AuditLedger({ path, key: KEY });
    l1.append({ event: "e0", actor: "a" });
    l1.append({ event: "e1", actor: "a" });

    const l2 = new AuditLedger({ path, key: KEY });
    l2.append({ event: "e2", actor: "a" });

    const result = verifyLedger(path, KEY);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 3);
  });

  test("interleaved instances stay chained (tail re-read under lock)", () => {
    // Two live instances simulating two cooperating processes: with locking on
    // (the default) each append re-reads the tail, so the chain never forks.
    const l1 = new AuditLedger({ path, key: KEY });
    const l2 = new AuditLedger({ path, key: KEY });
    for (let i = 0; i < 3; i++) {
      l1.append({ event: `l1-${i}`, actor: "a" });
      l2.append({ event: `l2-${i}`, actor: "b" });
    }
    const result = verifyLedger(path, KEY);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 6);
  });

  test("verify passes on an empty/absent ledger", () => {
    const result = verifyLedger(path, KEY);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 0);
  });
});

describe("AuditLedger tamper detection", () => {
  test("detects an edited payload at the right index", () => {
    const ledger = new AuditLedger({ path, key: KEY });
    for (let i = 0; i < 4; i++) {
      ledger.append({ event: "decision", actor: "agent-1", inputs: { i } });
    }
    const recs = readRecords(path);
    // Tamper with line index 2's content, leaving its sig untouched.
    recs[2] = { ...recs[2]!, actor: "attacker" };
    writeFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = verifyLedger(path, KEY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.tamperedIndex, 2);
  });

  test("detects a deleted interior line via a broken chain link", () => {
    const ledger = new AuditLedger({ path, key: KEY });
    for (let i = 0; i < 4; i++) {
      ledger.append({ event: "decision", actor: "agent-1", inputs: { i } });
    }
    const recs = readRecords(path);
    recs.splice(1, 1); // drop line index 1
    writeFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = verifyLedger(path, KEY);
    assert.equal(result.ok, false);
    // Former line 2 (now at index 1) has a prev_sig that no longer matches.
    if (!result.ok) assert.equal(result.tamperedIndex, 1);
  });

  test("fails verification under the wrong key", () => {
    const ledger = new AuditLedger({ path, key: KEY });
    ledger.append({ event: "e0", actor: "a" });
    const result = verifyLedger(path, "the-wrong-key");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.tamperedIndex, 0);
  });
});

describe("AuditLedger cross-language wire format", () => {
  test("matches the shared golden signature vector", () => {
    // The Python and Rust ports assert this exact signature too, so the
    // implementations can never silently drift on canonicalization / signing.
    const ledger = new AuditLedger({ path, key: "k" });
    const sig = ledger.append({
      event: "e",
      actor: "a",
      inputs: { x: 1 },
      sources: ["s"],
      ts: "2026-01-01T00:00:00Z",
    });
    assert.equal(
      sig,
      "d379966f5be33822aa1091efa18034e67e679fbadb168bb73c3f42ef712a46fc",
    );
  });
});

describe("AuditLedger key resolution", () => {
  test("falls back to the documented default key", () => {
    const l1 = new AuditLedger({ path, key: DEFAULT_AUDIT_LEDGER_KEY });
    l1.append({ event: "e0", actor: "a" });
    // No key passed -> resolves to env or the default; here env is unset.
    const result = verifyLedger(path);
    assert.equal(result.ok, true);
  });
});

describe("AuditLedger multi-process lockfile", () => {
  test("a held (fresh) lock makes append fail with LedgerLockError", () => {
    const ledger = new AuditLedger({
      path,
      key: KEY,
      lockTimeoutMs: 120,
      lockRetryMs: 10,
      lockStaleMs: 60_000,
    });
    writeFileSync(`${path}.lock`, "another-pid\n"); // simulate a live writer
    assert.throws(
      () => ledger.append({ event: "e0", actor: "a" }),
      LedgerLockError,
    );
  });

  test("a stale lock is reclaimed and the append succeeds", () => {
    const ledger = new AuditLedger({
      path,
      key: KEY,
      lockTimeoutMs: 500,
      lockRetryMs: 10,
      lockStaleMs: 50,
    });
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "crashed-pid\n");
    // Backdate the lock's mtime so it is unambiguously stale.
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    const sig = ledger.append({ event: "e0", actor: "a" });
    assert.equal(typeof sig, "string");
    const result = ledger.verify();
    assert.equal(result.ok, true);
  });

  test("lock: false preserves the donor single-process behavior", () => {
    const ledger = new AuditLedger({ path, key: KEY, lock: false });
    ledger.append({ event: "e0", actor: "a" });
    ledger.append({ event: "e1", actor: "a" });
    const result = ledger.verify();
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 2);
  });
});
