/**
 * @cubiczan/agent-governance — domain-event → HMAC ledger adapter.
 *
 * Apps want a semi-automatic audit trail without putting `UserId` / actor
 * on the entity (the EF Core / DDD "domain events on SaveChanges" pattern).
 * The aggregate raises facts; the application handler attaches the actor
 * and appends to the existing {@link AuditLedger}.
 *
 * This adapter does **not** invent a parallel hash or decision stack:
 *
 *   - Records use the same HMAC-SHA256 + `prev_sig` scheme as CHP and
 *     finance-analysis (canonical JSON payload, golden vector unchanged).
 *   - Capital-moving events optionally map onto {@link ChpGate.evaluate}
 *     so HITL, policy, and the daily cap still apply.
 *   - Non-capital events are a direct `ledger.append` — same sink, no gate.
 *
 * Connector assumption: the caller already knows the actor (HTTP user,
 * service identity, agent id). The entity never sees it.
 */

import { randomUUID } from "node:crypto";
import {
  ChpGate,
  type ChpDecision,
  type DecisionSink,
  type ProposedAction,
} from "./gate.js";
import { createPolicy, type Policy } from "./policy.js";
import type { AuditRecord } from "./ledger.js";

/** Prefix written to {@link AuditRecord.event} for every dispatched domain fact. */
export const DOMAIN_LEDGER_EVENT_PREFIX = "domain.";

/** A fact raised by an aggregate. No actor / UserId — that is attached later. */
export interface DomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  /** Provenance of the facts (report ids, connectors) — never the actor. */
  readonly sources?: readonly string[];
}

/** Result of dispatching one domain event onto the signed ledger. */
export interface DomainEventDispatch {
  readonly event: DomainEvent;
  /** Actor attached by the application handler, never by the entity. */
  readonly actor: string;
  /** HMAC signature of the `domain.*` ledger line. */
  readonly sig: string;
  /** Present when the event was mapped onto {@link ChpGate.evaluate}. */
  readonly decision?: ChpDecision;
}

export interface DomainEventHandlerOptions {
  /** Required: domain facts land on this sink (typically an AuditLedger). */
  ledger: DecisionSink;
  /**
   * Current user / service / agent. Attached on every append. Override
   * per call with the second argument to {@link DomainEventLedgerHandler.dispatch}.
   */
  actor: string;
  /**
   * Optional CHP gate. Required when {@link DomainEventHandlerOptions.mapToAction}
   * yields a proposed action (fail-closed: capital-moving events never skip HITL).
   */
  gate?: ChpGate;
  /**
   * Map a domain fact onto a governed action. Return `undefined` for
   * non-capital events (cancel, note, …) so they skip the gate.
   */
  mapToAction?: (event: DomainEvent) => ProposedAction | undefined;
}

export interface OrderState {
  readonly orderId: string;
  readonly status: "open" | "cancelled" | "filled";
  readonly asset: string;
  readonly qty: number;
  readonly notionalUsd: number;
  readonly venue: string;
}

export interface OpenOrderInput {
  readonly orderId: string;
  readonly asset: string;
  readonly qty: number;
  readonly notionalUsd: number;
  readonly venue: string;
  readonly occurredAt?: string;
  readonly eventId?: string;
}

/** Cookbook CHP policy for the synthetic order aggregate (capital-moving opens). */
export function defaultDomainEventOrderPolicy(): Policy {
  return createPolicy({
    version: "domain-event-order-1.0",
    maxNotionalUsd: 5000,
    dailyNotionalCapUsd: 20000,
    hitlThresholdUsd: 1000,
    allowedActions: ["buy", "sell"],
    perAssetLimits: { ETH: 5000, SOL: 3000 },
    minConfidence: 0.5,
    allowedVenues: ["hyperliquid", "polymarket"],
  });
}

/**
 * Default mapper: `order.opened` is a buy; cancel / fill are facts only.
 * Used by the cookbook so a capital-moving entity never talks to the gate
 * itself — the handler does.
 */
export function mapOrderEventToAction(event: DomainEvent): ProposedAction | undefined {
  if (event.aggregateType !== "Order" || event.eventType !== "order.opened") {
    return undefined;
  }
  const payload = event.payload as {
    asset?: unknown;
    notionalUsd?: unknown;
    venue?: unknown;
  };
  if (typeof payload.asset !== "string" || typeof payload.notionalUsd !== "number") {
    return undefined;
  }
  const proposed: ProposedAction = {
    action: "buy",
    asset: payload.asset,
    notionalUsd: payload.notionalUsd,
    rationale: `${event.eventType} ${event.aggregateId}`,
  };
  if (typeof payload.venue === "string") proposed.venue = payload.venue;
  return proposed;
}

/**
 * Application-layer handler: attach actor, append to the HMAC ledger,
 * optionally evaluate through CHP. The entity is never passed in.
 */
export class DomainEventLedgerHandler {
  private readonly ledger: DecisionSink;
  private readonly actor: string;
  private readonly gate?: ChpGate;
  private readonly mapToAction?: (event: DomainEvent) => ProposedAction | undefined;

  constructor(options: DomainEventHandlerOptions) {
    this.ledger = options.ledger;
    this.actor = options.actor;
    if (options.gate !== undefined) this.gate = options.gate;
    if (options.mapToAction !== undefined) this.mapToAction = options.mapToAction;
  }

  getActor(): string {
    return this.actor;
  }

  getChpGate(): ChpGate | undefined {
    return this.gate;
  }

  /**
   * Persist one domain event. The actor comes from the handler (or
   * `actorOverride` for a multi-user process) — never from the event.
   *
   * Capital-moving mappings are fail-closed: a mapper result without a
   * configured gate throws rather than writing an unaudited decision.
   */
  dispatch(event: DomainEvent, actorOverride?: string): DomainEventDispatch {
    const leaked = event as DomainEvent & {
      actor?: unknown;
      userId?: unknown;
      UserId?: unknown;
    };
    if (leaked.actor !== undefined || leaked.userId !== undefined || leaked.UserId !== undefined) {
      throw new Error("DomainEventLedgerHandler: domain events must not carry actor/UserId");
    }
    const actor = actorOverride ?? this.actor;
    const mapped = this.mapToAction?.(event);
    if (mapped !== undefined && this.gate === undefined) {
      throw new Error(
        `DomainEventLedgerHandler: capital-moving event ${event.eventType} requires a ChpGate`,
      );
    }

    const sig = this.ledger.append({
      event: `${DOMAIN_LEDGER_EVENT_PREFIX}${event.eventType}`,
      actor,
      inputs: {
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
      },
      sources: event.sources ?? [`aggregate:${event.aggregateType}:${event.aggregateId}`],
      rationale: `${event.eventType} on ${event.aggregateType} ${event.aggregateId}`,
      ts: event.occurredAt,
    });

    if (mapped === undefined || this.gate === undefined) {
      return { event, actor, sig };
    }
    const decision = this.gate.evaluate(mapped);
    return { event, actor, sig, decision };
  }

  dispatchAll(events: readonly DomainEvent[], actorOverride?: string): DomainEventDispatch[] {
    return events.map((event) => this.dispatch(event, actorOverride));
  }

  /** Promote a HITL-gated capital-moving event. Approver is a ledger actor. */
  approveHuman(decisionId: string, approver: string): ChpDecision {
    if (this.gate === undefined) {
      throw new Error("DomainEventLedgerHandler: approveHuman requires a ChpGate");
    }
    return this.gate.approveHuman(decisionId, approver);
  }
}

/**
 * Cookbook aggregate: an order book entry with **no UserId**.
 *
 * Mirrors the EF pattern — the entity records what happened; identity is
 * attached when {@link DomainEventLedgerHandler} dispatches pulled events.
 */
export class Order {
  private state: OrderState;
  private readonly pending: DomainEvent[] = [];

  private constructor(state: OrderState) {
    this.state = state;
  }

  static open(input: OpenOrderInput): Order {
    const order = new Order({
      orderId: input.orderId,
      status: "open",
      asset: input.asset,
      qty: input.qty,
      notionalUsd: input.notionalUsd,
      venue: input.venue,
    });
    order.record(
      "order.opened",
      {
        asset: input.asset,
        qty: input.qty,
        notionalUsd: input.notionalUsd,
        venue: input.venue,
      },
      input,
    );
    return order;
  }

  /** Reconstruct from events without re-raising (replay / event-source). */
  static fromEvents(events: readonly DomainEvent[]): Order {
    if (events.length === 0) {
      throw new Error("Order.fromEvents: at least one event is required");
    }
    const first = events[0]!;
    if (first.eventType !== "order.opened" || first.aggregateType !== "Order") {
      throw new Error("Order.fromEvents: stream must start with Order order.opened");
    }
    const order = new Order({
      orderId: first.aggregateId,
      status: "open",
      asset: "",
      qty: 0,
      notionalUsd: 0,
      venue: "",
    });
    for (const event of events) {
      order.apply(event);
    }
    return order;
  }

  cancel(reason: string, opts?: { occurredAt?: string; eventId?: string }): void {
    if (this.state.status !== "open") {
      throw new Error(`Order.cancel: cannot cancel a ${this.state.status} order`);
    }
    this.state = { ...this.state, status: "cancelled" };
    this.record("order.cancelled", { reason }, opts);
  }

  fill(opts?: { occurredAt?: string; eventId?: string }): void {
    if (this.state.status !== "open") {
      throw new Error(`Order.fill: cannot fill a ${this.state.status} order`);
    }
    this.state = { ...this.state, status: "filled" };
    this.record("order.filled", { qty: this.state.qty }, opts);
  }

  snapshot(): OrderState {
    return { ...this.state };
  }

  /** Drain unpublished facts. The entity still has no actor after this. */
  pullDomainEvents(): DomainEvent[] {
    return this.pending.splice(0);
  }

  private record(
    eventType: string,
    payload: unknown,
    opts?: { occurredAt?: string; eventId?: string },
  ): void {
    const event: DomainEvent = {
      eventId: opts?.eventId ?? randomUUID(),
      eventType,
      occurredAt: opts?.occurredAt ?? new Date().toISOString(),
      aggregateType: "Order",
      aggregateId: this.state.orderId,
      payload,
      sources: [`aggregate:Order:${this.state.orderId}`],
    };
    this.pending.push(event);
  }

  private apply(event: DomainEvent): void {
    if (event.aggregateType !== "Order" || event.aggregateId !== this.state.orderId) {
      throw new Error(
        `Order.apply: event ${event.eventType} is not for Order ${this.state.orderId}`,
      );
    }
    if (event.eventType === "order.opened") {
      const payload = event.payload as {
        asset: string;
        qty: number;
        notionalUsd: number;
        venue: string;
      };
      this.state = {
        orderId: event.aggregateId,
        status: "open",
        asset: payload.asset,
        qty: payload.qty,
        notionalUsd: payload.notionalUsd,
        venue: payload.venue,
      };
      return;
    }
    if (event.eventType === "order.cancelled") {
      this.state = { ...this.state, status: "cancelled" };
      return;
    }
    if (event.eventType === "order.filled") {
      this.state = { ...this.state, status: "filled" };
      return;
    }
    throw new Error(`Order.apply: unknown event type ${event.eventType}`);
  }
}

/** Synthetic order used by the cookbook and tests (not a real venue fill). */
export function syntheticOpenedOrder(): Order {
  return Order.open({
    orderId: "ord-northwind-eth-001",
    asset: "ETH",
    qty: 1.5,
    notionalUsd: 750,
    venue: "hyperliquid",
    occurredAt: "2026-09-07T00:00:00.000Z",
    eventId: "evt-ord-northwind-eth-001-opened",
  });
}

/** True when a ledger line was written by {@link DomainEventLedgerHandler}. */
export function isDomainLedgerEvent(eventName: string): boolean {
  return eventName.startsWith(DOMAIN_LEDGER_EVENT_PREFIX);
}

/**
 * Rehydrate a {@link DomainEvent} from a signed ledger record. Returns
 * `undefined` for CHP / finance / rotation lines so replay can skip them.
 */
export function domainEventFromRecord(record: AuditRecord): DomainEvent | undefined {
  if (!isDomainLedgerEvent(record.event)) return undefined;
  const inputs = record.inputs;
  if (!inputs || typeof inputs !== "object") return undefined;
  const body = inputs as Partial<DomainEvent>;
  if (
    typeof body.eventId !== "string" ||
    typeof body.eventType !== "string" ||
    typeof body.occurredAt !== "string" ||
    typeof body.aggregateType !== "string" ||
    typeof body.aggregateId !== "string"
  ) {
    return undefined;
  }
  const sources = Array.isArray(record.sources)
    ? record.sources.filter((s): s is string => typeof s === "string")
    : undefined;
  const event: DomainEvent = {
    eventId: body.eventId,
    eventType: body.eventType,
    occurredAt: body.occurredAt,
    aggregateType: body.aggregateType,
    aggregateId: body.aggregateId,
    payload: body.payload,
    ...(sources !== undefined ? { sources } : {}),
  };
  return event;
}

/** Extract domain events from a verified JSONL record list, in chain order. */
export function domainEventsFromRecords(records: readonly AuditRecord[]): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (const record of records) {
    const event = domainEventFromRecord(record);
    if (event) events.push(event);
  }
  return events;
}
