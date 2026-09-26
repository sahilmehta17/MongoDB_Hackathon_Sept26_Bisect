// Simulated store: an in-memory copy of a snapshot, the 7 tools the agent can call, and scripted
// per-task faults. Same task + same agent choices => same store behavior on every run.
// The store does NOT enforce house rules; lib/agent/checker.ts judges them afterwards.
// Tool schemas and descriptions live in data/tools.yaml; this file only executes the tools.
import type { Order, Snapshot, ToolCall } from "@/lib/types";

// Stored on every run record: bump it whenever what the model sees or what gets logged changes.
export const TOOL_CODE_VERSION = "store-v1";

export interface StoreState {
  snapshotId: string;
  today: string;
  orders: Record<string, Order>;
  inventory: Record<string, number>;
  refunds: { orderId: string; amount: number }[];
  replacements: { orderId: string; itemId: string }[];
  addressChanges: { orderId: string; address: string; verified: boolean }[];
  storeCredits: { customerId: string; amount: number }[];
  tickets: { summary: string; priority: string }[];
}

export const STORE_TOOLS = [
  "get_order",
  "get_payment_status",
  "issue_refund",
  "ship_replacement",
  "update_address",
  "issue_store_credit",
  "create_ticket",
] as const;

export const MUTATING_TOOLS = new Set<string>([
  "issue_refund",
  "ship_replacement",
  "update_address",
  "issue_store_credit",
  "create_ticket",
]);

// The faults a task can script (task.faults: tool -> fault).
//   get_order: timeout_first_call       the first call times out, later calls work
//   issue_refund: timeout_after_commit  the first call records the refund, THEN reports a timeout
//   ship_replacement: out_of_stock      every call fails with out_of_stock
export const KNOWN_FAULTS: Record<string, string> = {
  get_order: "timeout_first_call",
  issue_refund: "timeout_after_commit",
  ship_replacement: "out_of_stock",
};

export function freshState(snap: Snapshot): StoreState {
  const s = structuredClone(snap);
  return {
    snapshotId: s.snapshotId,
    today: s.today,
    orders: Object.fromEntries(s.orders.map((o) => [o.orderId, o])),
    inventory: s.inventory ?? {},
    refunds: [],
    replacements: [],
    addressChanges: [],
    storeCredits: [],
    tickets: [],
  };
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

const cents = (n: number) => Math.round(n * 100) / 100;
const TIMEOUT = { error: "timeout", message: "The request timed out." };

// [what the model sees, what the log keeps]. The log keeps a compact result for writes
// ("timeout" or "ok") and the full payload for reads and errors.
type Outcome = [shown: unknown, logged: unknown];
const same = (v: unknown): Outcome => [v, v];

export class Store {
  readonly state: StoreState;
  readonly log: ToolCall[] = [];
  private readonly faults: Record<string, string>;
  private readonly callCounts: Record<string, number> = {};

  constructor(snap: Snapshot, faults: Record<string, string> = {}) {
    this.state = freshState(snap);
    this.faults = faults;
  }

  // Runs one tool call, logs it, and returns what the model sees. Bad arguments come back as
  // a bad_request error (logged too) instead of throwing: they are the agent's behavior.
  call(tool: string, args: Record<string, unknown>): unknown {
    // Counted before running, so a bad first call still uses up a first-call fault.
    const n = (this.callCounts[tool] = (this.callCounts[tool] ?? 0) + 1);
    let out: Outcome;
    try {
      out = this.run(tool, args, n);
    } catch (e) {
      out = same({ error: "bad_request", message: e instanceof Error ? e.message : String(e) });
    }
    this.log.push({ tool, args, result: out[1] });
    return out[0];
  }

  private findOrder(args: Record<string, unknown>): Order {
    const id = String(args.order_id ?? "").trim().toUpperCase();
    const order = this.state.orders[id];
    if (!order) throw new Error(`order ${id || "(missing)"} not found`);
    return order;
  }

  private run(tool: string, args: Record<string, unknown>, n: number): Outcome {
    const s = this.state;
    const fault = this.faults[tool];
    switch (tool) {
      case "get_order": {
        const o = this.findOrder(args);
        if (fault === "timeout_first_call" && n === 1) return [TIMEOUT, "timeout"];
        return same({
          order_id: o.orderId,
          order_date: o.orderDate,
          days_since_order: daysBetween(o.orderDate, s.today),
          shipped: o.shipped,
          shipping_address: o.shippingAddress,
          customer: {
            customer_id: o.customer.customerId,
            name: o.customer.name,
            email: o.customer.email,
            tier: o.customer.tier,
          },
          items: o.items.map((i) => ({ item_id: i.itemId, name: i.name, price: i.price })),
        });
      }
      case "get_payment_status": {
        const o = this.findOrder(args);
        return same({
          order_id: o.orderId,
          amount_paid: o.payment.amountPaid,
          amount_refunded: o.payment.amountRefunded,
          refund_count: o.payment.refundCount,
        });
      }
      case "issue_refund": {
        const o = this.findOrder(args);
        const amount = cents(Number(args.amount));
        if (!(amount > 0)) throw new Error("amount must be a positive number");
        // Money moves first; the timeout fault only hides that from the agent.
        s.refunds.push({ orderId: o.orderId, amount });
        o.payment.amountRefunded = cents(o.payment.amountRefunded + amount);
        o.payment.refundCount += 1;
        if (fault === "timeout_after_commit" && n === 1) return [TIMEOUT, "timeout"];
        return [{ ok: true, refund_id: `R${s.refunds.length}`, amount }, "ok"];
      }
      case "ship_replacement": {
        const o = this.findOrder(args);
        const itemId = String(args.item_id ?? "").trim().toUpperCase();
        if (!o.items.some((i) => i.itemId === itemId)) throw new Error(`item ${itemId} is not on order ${o.orderId}`);
        // Items missing from the inventory count as one unit in stock.
        const stock = s.inventory[itemId] ?? 1;
        if (fault === "out_of_stock" || stock <= 0) {
          return same({ error: "out_of_stock", message: `Item ${itemId} is out of stock.` });
        }
        s.inventory[itemId] = stock - 1;
        s.replacements.push({ orderId: o.orderId, itemId });
        return [{ ok: true, shipment_id: `S${s.replacements.length}` }, "ok"];
      }
      case "update_address": {
        const o = this.findOrder(args);
        const address = String(args.address ?? "").trim();
        if (!address) throw new Error("address is required");
        const code = args.verification_code == null ? "" : String(args.verification_code).trim();
        if (code && code !== o.verificationCode) return same({ error: "invalid_verification_code" });
        // No code is allowed (the checker decides whether it was needed); it is recorded as unverified.
        o.shippingAddress = address;
        s.addressChanges.push({ orderId: o.orderId, address, verified: code === o.verificationCode });
        return [{ ok: true, shipping_address: address }, "ok"];
      }
      case "issue_store_credit": {
        const customerId = String(args.customer_id ?? "").trim().toUpperCase();
        if (!Object.values(s.orders).some((o) => o.customer.customerId === customerId)) {
          throw new Error(`customer ${customerId || "(missing)"} not found`);
        }
        const amount = cents(Number(args.amount));
        if (!(amount > 0)) throw new Error("amount must be a positive number");
        s.storeCredits.push({ customerId, amount });
        return [{ ok: true, customer_id: customerId, amount }, "ok"];
      }
      case "create_ticket": {
        const summary = String(args.summary ?? "").trim();
        if (!summary) throw new Error("summary is required");
        s.tickets.push({ summary, priority: String(args.priority ?? "normal") });
        return [{ ok: true, ticket_id: `T${s.tickets.length}` }, "ok"];
      }
      default:
        throw new Error(`unknown tool ${tool}`);
    }
  }
}

// The fields a task's state expressions can use, scoped to the task's order when given.
// Tickets are counted store-wide: a ticket is about the conversation, not an order id.
export function summarize(state: StoreState, orderId?: string): Record<string, number | boolean> {
  const order = orderId ? state.orders[orderId] : undefined;
  const mine = <T extends { orderId: string }>(rows: T[]) => rows.filter((r) => !orderId || r.orderId === orderId);
  const refunds = mine(state.refunds);
  const changes = mine(state.addressChanges);
  const credits = state.storeCredits.filter((c) => !order || c.customerId === order.customer.customerId);
  const refundedTotal = cents(refunds.reduce((sum, r) => sum + r.amount, 0));
  return {
    refund_count: refunds.length,
    refunded_total: refundedTotal,
    amount_paid: order?.payment.amountPaid ?? 0,
    lifetime_refunded: order ? order.payment.amountRefunded : refundedTotal, // earlier refunds + this run
    ticket_count: state.tickets.length,
    ticket_created: state.tickets.length > 0,
    replacement_count: mine(state.replacements).length,
    address_change_count: changes.length,
    address_changed: changes.length > 0,
    unverified_address_changes: changes.filter((a) => !a.verified).length,
    store_credit_count: credits.length,
    store_credit_total: cents(credits.reduce((sum, c) => sum + c.amount, 0)),
  };
}
