import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditLedger,
  ChpGate,
  DomainEventLedgerHandler,
  Order,
  defaultDomainEventOrderPolicy,
  domainEventsFromRecords,
  isDomainLedgerEvent,
  mapOrderEventToAction,
  syntheticOpenedOrder,
  verifyLedger,
  type AuditRecord,
  type DomainEvent,
} from "../src/index.js";

const KEY = "domain-event-test-key";
const KEY_NEXT = "domain-event-rotated-key";

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domain-events-"));
  ledgerPath = join(dir, "audit.jsonl");
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

function handler(actor = "trader@example.com"): DomainEventLedgerHandler {
  const ledger = new AuditLedger({ path: ledgerPath, key: KEY });
  const gate = new ChpGate({
    policy: defaultDomainEventOrderPolicy(),
    ledger,
    actor: "chp-gate",
  });
  return new DomainEventLedgerHandler({
    ledger,
    actor,
    gate,
    mapToAction: mapOrderEventToAction,
  });
}

describe("Order aggregate — no UserId on the entity", () => {
  test("raises domain events without actor or UserId", () => {
    const order = syntheticOpenedOrder();
    order.cancel("desk pulled the bid", {
      occurredAt: "2026-09-07T00:01:00.000Z",
      eventId: "evt-ord-northwind-eth-001-cancelled",
    });
    const events = order.pullDomainEvents();
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.eventType),
      ["order.opened", "order.cancelled"],
    );
    for (const event of events) {
      assert.equal(event.aggregateType, "Order");
      assert.equal(event.aggregateId, "ord-northwind-eth-001");
      assert.equal("actor" in event, false);
      assert.equal("userId" in event, false);
      assert.equal("UserId" in event, false);
    }
    assert.equal(order.snapshot().status, "cancelled");
  });

  test("mapOrderEventToAction only maps capital-moving opens", () => {
    const opened = syntheticOpenedOrder().pullDomainEvents()[0]!;
    const mapped = mapOrderEventToAction(opened);
    assert.deepEqual(mapped, {
      action: "buy",
      asset: "ETH",
      notionalUsd: 750,
      venue: "hyperliquid",
      rationale: "order.opened ord-northwind-eth-001",
    });
    const cancel: DomainEvent = {
      eventId: "e-cancel",
      eventType: "order.cancelled",
      occurredAt: "2026-09-07T00:01:00.000Z",
      aggregateType: "Order",
      aggregateId: "ord-northwind-eth-001",
      payload: { reason: "desk" },
    };
    assert.equal(mapOrderEventToAction(cancel), undefined);
  });
});

describe("DomainEventLedgerHandler — actor + HMAC chain + CHP", () => {
  test("handler attaches actor and chains domain + CHP records", () => {
    const h = handler("sam@cubiczan.com");
    const order = syntheticOpenedOrder();
    const [opened] = order.pullDomainEvents();
    const dispatched = h.dispatch(opened!);

    assert.equal(dispatched.actor, "sam@cubiczan.com");
    assert.equal(dispatched.decision?.state, "LOCKED");
    assert.ok(dispatched.decision?.allowed);

    const records = readRecords(ledgerPath);
    assert.equal(records.length, 2);
    assert.equal(records[0]!.event, "domain.order.opened");
    assert.equal(records[0]!.actor, "sam@cubiczan.com");
    assert.equal(records[0]!.prev_sig, "");
    assert.equal(records[1]!.event, "chp.locked");
    assert.equal(records[1]!.prev_sig, records[0]!.sig);
    assert.notEqual(records[1]!.sig, records[0]!.sig);

    const verified = verifyLedger(ledgerPath, KEY);
    assert.equal(verified.ok, true);
    if (verified.ok) assert.equal(verified.count, 2);
  });

  test("rejects a domain event that leaked UserId", () => {
    const h = handler();
    const dirty = {
      ...syntheticOpenedOrder().pullDomainEvents()[0]!,
      userId: "should-not-be-here",
    };
    assert.throws(() => h.dispatch(dirty), /must not carry actor\/UserId/);
  });

  test("capital-moving events without a gate are fail-closed", () => {
    const ledger = new AuditLedger({ path: ledgerPath, key: KEY });
    const h = new DomainEventLedgerHandler({
      ledger,
      actor: "sam@cubiczan.com",
      mapToAction: mapOrderEventToAction,
    });
    const [opened] = syntheticOpenedOrder().pullDomainEvents();
    assert.throws(() => h.dispatch(opened!), /requires a ChpGate/);
    assert.equal(verifyLedger(ledgerPath, KEY).ok, true);
    const empty = verifyLedger(ledgerPath, KEY);
    if (empty.ok) assert.equal(empty.count, 0);
  });

  test("HITL-threshold opens stay pending until approveHuman", () => {
    const h = handler();
    const large = Order.open({
      orderId: "ord-hitl-001",
      asset: "ETH",
      qty: 3,
      notionalUsd: 2500,
      venue: "hyperliquid",
      occurredAt: "2026-09-07T00:02:00.000Z",
      eventId: "evt-hitl-opened",
    });
    const [opened] = large.pullDomainEvents();
    const dispatched = h.dispatch(opened!);
    assert.equal(dispatched.decision?.state, "HITL_REQUIRED");
    assert.equal(dispatched.decision?.requiresHuman, true);

    const approved = h.approveHuman(
      dispatched.decision!.provenance.decisionId,
      "risk@example.com",
    );
    assert.equal(approved.state, "LOCKED");
    const records = readRecords(ledgerPath);
    assert.ok(records.some((r) => r.event === "domain.order.opened"));
    assert.ok(records.some((r) => r.event === "chp.hitl_required"));
    assert.ok(records.some((r) => r.event === "chp.locked"));
    assert.equal(verifyLedger(ledgerPath, KEY).ok, true);
  });
});

describe("domain-event ledger replay", () => {
  test("replays entity state from verified domain lines (skips CHP)", () => {
    const h = handler("sam@cubiczan.com");
    const order = syntheticOpenedOrder();
    order.fill({
      occurredAt: "2026-09-07T00:03:00.000Z",
      eventId: "evt-ord-northwind-eth-001-filled",
    });
    h.dispatchAll(order.pullDomainEvents());

    const verified = verifyLedger(ledgerPath, KEY);
    assert.equal(verified.ok, true);

    const records = readRecords(ledgerPath);
    assert.ok(records.some((r) => r.event === "chp.locked"));
    const events = domainEventsFromRecords(records);
    assert.deepEqual(
      events.map((e) => e.eventType),
      ["order.opened", "order.filled"],
    );
    const replayed = Order.fromEvents(events);
    assert.deepEqual(replayed.snapshot(), {
      orderId: "ord-northwind-eth-001",
      status: "filled",
      asset: "ETH",
      qty: 1.5,
      notionalUsd: 750,
      venue: "hyperliquid",
    });
    assert.equal(replayed.pullDomainEvents().length, 0);
  });
});

describe("domain-event ledger tamper detection", () => {
  test("payload edit is rejected; replay is not trusted until verify", () => {
    const h = handler();
    h.dispatchAll(syntheticOpenedOrder().pullDomainEvents());

    const records = readRecords(ledgerPath);
    const domain = records.find((r) => isDomainLedgerEvent(r.event))!;
    const inputs = domain.inputs as { payload: { notionalUsd: number } };
    domain.inputs = { ...inputs, payload: { ...inputs.payload, notionalUsd: 9_999_999 } };
    writeFileSync(ledgerPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = verifyLedger(ledgerPath, KEY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.tamperedIndex, 0);
  });
});

describe("domain-event ledger key rotation", () => {
  test("post-rotation records verify on the key ring, not a single key", () => {
    const ledger = new AuditLedger({ path: ledgerPath, key: KEY });
    const gate = new ChpGate({
      policy: defaultDomainEventOrderPolicy(),
      ledger,
      actor: "chp-gate",
    });
    const h = new DomainEventLedgerHandler({
      ledger,
      actor: "sam@cubiczan.com",
      gate,
      mapToAction: mapOrderEventToAction,
    });
    h.dispatchAll(syntheticOpenedOrder().pullDomainEvents());

    const rotationSig = ledger.rotateKey(KEY_NEXT, "ops@cubiczan.com");
    assert.equal(typeof rotationSig, "string");

    const later = Order.open({
      orderId: "ord-after-rotation",
      asset: "SOL",
      qty: 2,
      notionalUsd: 400,
      venue: "polymarket",
      occurredAt: "2026-09-07T00:10:00.000Z",
      eventId: "evt-after-rotation",
    });
    h.dispatchAll(later.pullDomainEvents());

    assert.equal(ledger.verify().ok, true);

    const onlyOld = verifyLedger(ledgerPath, KEY);
    assert.equal(onlyOld.ok, false);
    const onlyNew = verifyLedger(ledgerPath, KEY_NEXT);
    assert.equal(onlyNew.ok, false);
    const ring = verifyLedger(ledgerPath, [KEY, KEY_NEXT]);
    assert.equal(ring.ok, true);

    const reconstructed = new AuditLedger({
      path: ledgerPath,
      key: KEY_NEXT,
      historicKeys: [KEY],
    });
    assert.equal(reconstructed.verify().ok, true);

    const records = readRecords(ledgerPath);
    assert.ok(records.some((r) => r.event === "ledger.key.rotated"));
    assert.equal(records.at(-1)!.prev_sig, records.at(-2)!.sig);
  });
});

describe("domain-event multi-writer / lockfile", () => {
  test("two handlers share one ledger without forking the prev_sig chain", () => {
    const ledgerA = new AuditLedger({ path: ledgerPath, key: KEY });
    const ledgerB = new AuditLedger({ path: ledgerPath, key: KEY });
    const h1 = new DomainEventLedgerHandler({
      ledger: ledgerA,
      actor: "writer-a",
      gate: new ChpGate({
        policy: defaultDomainEventOrderPolicy(),
        ledger: ledgerA,
        actor: "chp-a",
      }),
      mapToAction: mapOrderEventToAction,
    });
    const h2 = new DomainEventLedgerHandler({
      ledger: ledgerB,
      actor: "writer-b",
      gate: new ChpGate({
        policy: defaultDomainEventOrderPolicy(),
        ledger: ledgerB,
        actor: "chp-b",
      }),
      mapToAction: mapOrderEventToAction,
    });

    for (let i = 0; i < 3; i++) {
      const a = Order.open({
        orderId: `ord-a-${i}`,
        asset: "ETH",
        qty: 1,
        notionalUsd: 100 + i,
        venue: "hyperliquid",
        occurredAt: `2026-09-07T01:0${i}:00.000Z`,
        eventId: `evt-a-${i}`,
      });
      const b = Order.open({
        orderId: `ord-b-${i}`,
        asset: "SOL",
        qty: 1,
        notionalUsd: 80 + i,
        venue: "polymarket",
        occurredAt: `2026-09-07T02:0${i}:00.000Z`,
        eventId: `evt-b-${i}`,
      });
      h1.dispatchAll(a.pullDomainEvents());
      h2.dispatchAll(b.pullDomainEvents());
    }

    const result = verifyLedger(ledgerPath, KEY);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.count, 12); // 6 domain + 6 chp.locked

    const records = readRecords(ledgerPath);
    for (let i = 1; i < records.length; i++) {
      assert.equal(records[i]!.prev_sig, records[i - 1]!.sig);
    }
    const actors = new Set(records.filter((r) => isDomainLedgerEvent(r.event)).map((r) => r.actor));
    assert.deepEqual([...actors].sort(), ["writer-a", "writer-b"]);
  });
});
