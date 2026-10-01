// Latch billing webhook event handling: Stripe event -> settlement
// instruction (mirrors estate webhook.ts). Imported by the billing routes
// module (latchBilling.ts); shares the plan catalog via latchBillingCatalog.
import { LATCH_META, LATCH_PLANS_BY_ID } from "./latchBillingCatalog.js";

export function readText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function metadataOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export interface CreditInstruction {
  readonly customerEmail: string;
  readonly amountCents: number;
  readonly currency: "usd";
  readonly paymentId: string;
  readonly reason: string;
}

export interface PlanInstruction {
  readonly customerEmail: string;
  readonly plan: string | null;
  readonly subscriptionRef: string;
  readonly renewsAtMs: number | null;
}

export type EventOutcome =
  | { action: "credit"; credit: CreditInstruction; plan?: PlanInstruction }
  | { action: "plan"; plan: PlanInstruction }
  | { action: "ignore"; why: string };

/**
 * Reads metadata off an invoice: the new Stripe API puts it at
 * parent.subscription_details.metadata, the old one at
 * subscription_details.metadata (same compat read as estate webhook.ts).
 */
function invoiceMetadataOf(invoice: Record<string, unknown>): Record<string, unknown> {
  const parent = metadataOf(invoice["parent"]);
  const details = metadataOf(parent["subscription_details"] ?? invoice["subscription_details"]);
  return metadataOf(details["metadata"]);
}

/** Invoice coverage-period end (in ms); null when unreadable — never guessed. */
function periodEndOf(invoice: Record<string, unknown>): number | null {
  const lines = metadataOf(invoice["lines"]);
  const data = Array.isArray(lines["data"]) ? lines["data"] : [];
  let latest: number | null = null;
  for (const line of data) {
    const period = metadataOf(metadataOf(line)["period"]);
    const end = period["end"];
    if (
      typeof end === "number" &&
      Number.isFinite(end) &&
      end > 0 &&
      (latest === null || end > latest)
    ) {
      latest = end;
    }
  }
  return latest === null ? null : latest * 1000;
}

/**
 * Event -> settlement instruction, semantics aligned with estate webhook.ts
 * outcomeOf:
 * - checkout.session.completed credits only in payment mode (Latch sells only
 *   subscriptions; subscription sessions are NOT credited here — their first
 *   invoice.paid does it, avoiding a double first-period credit);
 * - invoice.paid credits only when it carries Latch subscription metadata, in
 *   the catalog's creditCents amount (the founder-adjustable constant).
 *
 * Critical premise: the founder's Latch test key shares one Stripe account
 * with the xlaunch estate billing services (verified: that account also
 * carries the billing.xlaunch.work / synapse / gridframes webhooks), so this
 * webhook also receives estate events — any event missing Latch metadata is
 * ignored and NEVER credited by customer_email fallback, or estate payments
 * would be double-credited.
 */
export function outcomeOf(event: Record<string, unknown>): EventOutcome {
  const type = readText(event["type"]);
  const object = metadataOf(metadataOf(event["data"])["object"]);
  const metadata = metadataOf(object["metadata"]);

  if (type === "checkout.session.completed") {
    // Only Latch's own metadata counts (written onto the session at checkout).
    if (metadata[LATCH_META.kind] !== "subscription") {
      return { action: "ignore", why: "not a Latch checkout session" };
    }
    if (object["mode"] !== "payment") {
      return { action: "ignore", why: "subscription sessions are credited by their invoice" };
    }
    if (object["payment_status"] !== "paid") {
      return { action: "ignore", why: "session is not paid yet" };
    }
    const email = readText(metadata[LATCH_META.email]);
    const id = readText(object["id"]);
    const amount = object["amount_total"];
    if (email === undefined || id === undefined) {
      return { action: "ignore", why: "session carries no account" };
    }
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return { action: "ignore", why: "session carries no amount" };
    }
    return {
      action: "credit",
      credit: {
        customerEmail: email,
        amountCents: amount,
        currency: "usd",
        paymentId: id,
        reason: "Latch gateway credit top-up",
      },
    };
  }

  if (type === "invoice.paid") {
    const id = readText(object["id"]);
    const invoiceMetadata = invoiceMetadataOf(object);
    // Only the Latch account inside subscription metadata counts (estate
    // invoices carry no Latch metadata and are dropped here). Never fall back
    // to customer_email.
    if (invoiceMetadata[LATCH_META.kind] !== "subscription") {
      return { action: "ignore", why: "not a Latch subscription invoice" };
    }
    const email = readText(invoiceMetadata[LATCH_META.email]);
    const plan = LATCH_PLANS_BY_ID.get(readText(invoiceMetadata[LATCH_META.plan]) ?? "");
    if (email === undefined || id === undefined) {
      return { action: "ignore", why: "invoice carries no account" };
    }
    const paid = object["amount_paid"];
    if (typeof paid !== "number" || paid <= 0) {
      return { action: "ignore", why: "nothing was paid on this invoice" };
    }
    const credit: CreditInstruction = {
      customerEmail: email,
      amountCents: plan ? plan.creditCents : paid,
      currency: "usd",
      paymentId: id,
      reason: plan ? `Latch ${plan.id} plan: included credit` : "Latch subscription payment",
    };
    const details = metadataOf(
      metadataOf(object["parent"])["subscription_details"] ?? object["subscription_details"],
    );
    const subscriptionRef = readText(details["subscription"]) ?? readText(object["subscription"]);
    if (subscriptionRef === undefined) {
      return { action: "credit", credit };
    }
    return {
      action: "credit",
      credit,
      plan: {
        customerEmail: email,
        plan: plan ? plan.id : null,
        subscriptionRef,
        renewsAtMs: periodEndOf(object),
      },
    };
  }

  return { action: "ignore", why: `event type ${type ?? "(unknown)"} moves no credit` };
}
