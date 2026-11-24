import { Router } from "express";
import { z } from "zod";

import { env } from "../env.js";
import { payments, toObjectId, users } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { stripe } from "./stripe.js";

const paymentsRouter = Router();

const verifySchema = z
  .object({
    sessionId: z.string().trim().min(5),
  })
  .strict();

// Helper: syncs payment record and user subscription in MongoDB
async function fulfillCheckout(session, callerUserId = null) {
  const userId =
    session.metadata?.userId ||
    session.client_reference_id ||
    callerUserId ||
    null;

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;

  const invoiceId =
    typeof session.invoice === "string"
      ? session.invoice
      : session.invoice?.id ?? null;

  const customerEmail =
    session.customer_details?.email || session.customer_email || "";

  // Derive billing interval
  const billingInterval =
    session.metadata?.billingInterval === "yearly" ||
    (session.amount_total && session.amount_total > 5000)
      ? "yearly"
      : "monthly";

  const planName =
    billingInterval === "yearly"
      ? "Hireloop Pro (Yearly)"
      : "Hireloop Pro (Monthly)";

  // Calculate current period end
  let currentPeriodEnd = null;
  if (session.subscription && typeof session.subscription === "object") {
    currentPeriodEnd = new Date(session.subscription.current_period_end * 1000);
  } else if (subscriptionId && stripe) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      currentPeriodEnd = new Date(sub.current_period_end * 1000);
    } catch {
      // Fallback: 1 month or 1 year from now
      currentPeriodEnd = new Date(
        Date.now() +
          (billingInterval === "yearly" ? 365 : 30) * 24 * 60 * 60 * 1000
      );
    }
  } else {
    currentPeriodEnd = new Date(
      Date.now() +
        (billingInterval === "yearly" ? 365 : 30) * 24 * 60 * 60 * 1000
    );
  }

  // 1. Idempotently record payment in payments collection
  const paymentDoc = {
    userId: userId ? toObjectId(userId) : null,
    stripeSessionId: session.id,
    stripePaymentIntentId: paymentIntentId,
    stripeInvoiceId: invoiceId,
    stripeSubscriptionId: subscriptionId,
    amount: session.amount_total ?? 0,
    currency: session.currency || "usd",
    planName,
    billingInterval,
    status: "succeeded",
    customerEmail,
    createdAt: new Date(),
  };

  await payments.updateOne(
    { stripeSessionId: session.id },
    { $setOnInsert: paymentDoc },
    { upsert: true }
  );

  // 2. Upgrade user document to Pro tier
  if (userId) {
    await users.updateOne(
      { _id: toObjectId(userId) },
      {
        $set: {
          "subscription.plan": "pro",
          "subscription.billingInterval": billingInterval,
          "subscription.status": "active",
          "subscription.stripeCustomerId":
            typeof session.customer === "string" ? session.customer : null,
          "subscription.stripeSubscriptionId": subscriptionId,
          "subscription.currentPeriodEnd": currentPeriodEnd,
          "subscription.cancelAtPeriodEnd": false,
          updatedAt: new Date(),
        },
      }
    );
  }

  return { ...paymentDoc, currentPeriodEnd };
}

// Verification endpoint called by the client upon landing on /checkout/success
export async function verifyCheckout(req, res) {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid session id" });
  }

  const { sessionId } = parsed.data;

  if (!stripe) {
    return res.status(500).json({ error: "Stripe is not configured on the server" });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "line_items", "payment_intent"],
    });

    if (session.status === "open") {
      return res.status(400).json({ error: "Session is still open" });
    }

    if (session.status !== "complete" || session.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment not completed" });
    }

    // Fulfill and record the payment immediately
    const callerId = req.user?.id || null;
    const payment = await fulfillCheckout(session, callerId);

    res.json({
      verified: true,
      plan: "pro",
      billingInterval: payment.billingInterval,
      amount: payment.amount,
      currency: payment.currency,
      payment,
    });
  } catch (err) {
    console.error("Payment verification failed:", err?.message || err);
    res.status(500).json({ error: "Could not verify payment session" });
  }
}

// Payment history for the authenticated user
export async function listUserPayments(req, res) {
  const rows = await payments
    .find({ userId: toObjectId(req.user.id) })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  const userDoc = await users.findOne(
    { _id: toObjectId(req.user.id) },
    { projection: { subscription: 1, usage: 1 } }
  );

  res.json({
    subscription: userDoc?.subscription ||
      req.user?.subscription || {
        plan: "free",
        status: "none",
        billingInterval: null,
      },
    usage: userDoc?.usage || req.user?.usage || {},
    payments: rows.map((p) => ({
      id: p._id.toString(),
      stripeSessionId: p.stripeSessionId,
      amount: p.amount,
      currency: p.currency,
      planName: p.planName,
      billingInterval: p.billingInterval,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
    })),
  });
}

// Webhook handler receiving signed Stripe events (mounted with raw body in index.js)
export async function paymentsWebhookHandler(req, res) {
  if (!stripe || !env.stripeWebhookSecret) {
    return res.status(500).send("Stripe webhook is not configured");
  }

  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing stripe-signature header");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, env.stripeWebhookSecret);
  } catch (err) {
    console.warn(`Stripe webhook signature check failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.payment_status === "paid" || session.status === "complete") {
          await fulfillCheckout(session);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const currentPeriodEnd = new Date(sub.current_period_end * 1000);
        const status =
          sub.status === "active" || sub.status === "trialing"
            ? "active"
            : sub.status === "past_due"
              ? "past_due"
              : "canceled";

        await users.updateOne(
          { "subscription.stripeSubscriptionId": sub.id },
          {
            $set: {
              "subscription.status": status,
              "subscription.currentPeriodEnd": currentPeriodEnd,
              "subscription.cancelAtPeriodEnd": Boolean(sub.cancel_at_period_end),
              updatedAt: new Date(),
            },
          }
        );
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await users.updateOne(
          { "subscription.stripeSubscriptionId": sub.id },
          {
            $set: {
              "subscription.plan": "free",
              "subscription.status": "canceled",
              updatedAt: new Date(),
            },
          }
        );
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error(`Error processing Stripe event ${event.type}:`, err);
    res.status(500).json({ error: "Failed to process webhook event" });
  }
}

// User routes (require authentication)
paymentsRouter.post("/checkout-verify", verifyCheckout);
paymentsRouter.get("/history", requireAuth, listUserPayments);

export { paymentsRouter };
