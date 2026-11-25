import { Router } from "express";
import { z } from "zod";

import { env } from "../env.js";
import { isObjectId, payments, toObjectId, users } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { stripe } from "./stripe.js";

const paymentsRouter = Router();

const verifySchema = z
  .object({
    sessionId: z.string().trim().min(5),
  })
  .strict();

// Safely converts Date, unix timestamp (seconds or ms), or ISO string to a valid Date, or null
export function toValidDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Stripe timestamps are in seconds (< 1e12); JS timestamps are in milliseconds
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toIsoOrNull(value) {
  const d = toValidDate(value);
  return d ? d.toISOString() : null;
}

// Helper: calculates the exact calendar expiration date (1 month or 1 year)
export function calculateExactExpirationDate(startDate, interval) {
  const base = toValidDate(startDate) || new Date();
  const d = new Date(base.getTime());
  if (interval === "yearly") {
    const targetMonth = d.getMonth();
    d.setFullYear(d.getFullYear() + 1);
    // Clamp Feb 29 -> Feb 28 on non-leap years
    if (d.getMonth() !== targetMonth) {
      d.setDate(0);
    }
  } else {
    const targetMonth = (d.getMonth() + 1) % 12;
    d.setMonth(d.getMonth() + 1);
    // Clamp month-end overflow (e.g. Jan 31 -> Feb 28/29 instead of Mar 3)
    if (d.getMonth() !== targetMonth) {
      d.setDate(0);
    }
  }
  return d;
}

// Extracts subscription period start & end across Stripe API versions
// Note: Stripe API >= 2025-03-31.basil moved current_period_start/end onto items.data[0]
export function extractSubscriptionPeriod(sub, fallbackStartDate, billingInterval) {
  const item0 = sub?.items?.data?.[0];

  const rawStart =
    sub?.current_period_start ??
    item0?.current_period_start ??
    sub?.start_date ??
    sub?.created ??
    null;

  const currentPeriodStart =
    toValidDate(rawStart) || toValidDate(fallbackStartDate) || new Date();

  const rawEnd =
    sub?.current_period_end ??
    item0?.current_period_end ??
    null;

  const currentPeriodEnd =
    toValidDate(rawEnd) ||
    calculateExactExpirationDate(currentPeriodStart, billingInterval);

  return { currentPeriodStart, currentPeriodEnd };
}

// Helper: syncs payment record and user subscription in MongoDB
async function fulfillCheckout(session, callerUserId = null) {
  const rawUserId =
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

  let userObjectId =
    typeof rawUserId === "string" && isObjectId(rawUserId)
      ? toObjectId(rawUserId)
      : null;

  if (!userObjectId && customerEmail) {
    const userByEmail = await users.findOne(
      { email: customerEmail },
      { projection: { _id: 1 } }
    );
    if (userByEmail) {
      userObjectId = userByEmail._id;
    }
  }

  const purchaseDate = toValidDate(session.created) || new Date();

  // Retrieve full Stripe subscription details if available
  let sub = null;
  if (session.subscription && typeof session.subscription === "object") {
    sub = session.subscription;
  } else if (subscriptionId && stripe) {
    try {
      sub = await stripe.subscriptions.retrieve(subscriptionId);
    } catch {
      sub = null;
    }
  }

  const stripeInterval = sub?.items?.data?.[0]?.price?.recurring?.interval;

  // Derive billing interval
  const billingInterval =
    session.metadata?.billingInterval === "yearly" ||
    stripeInterval === "year" ||
    (session.amount_total && session.amount_total > 5000)
      ? "yearly"
      : "monthly";

  const planName =
    billingInterval === "yearly"
      ? "Hireloop Pro (Yearly)"
      : "Hireloop Pro (Monthly)";

  const { currentPeriodStart, currentPeriodEnd } = extractSubscriptionPeriod(
    sub,
    purchaseDate,
    billingInterval
  );

  const cancelAtPeriodEnd = Boolean(sub?.cancel_at_period_end);
  const subStatus =
    sub?.status === "canceled" || cancelAtPeriodEnd
      ? "canceled"
      : sub?.status === "past_due"
        ? "past_due"
        : "active";

  // 1. Idempotently record payment in payments collection
  const paymentDoc = {
    userId: userObjectId,
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
    createdAt: purchaseDate,
  };

  await payments.updateOne(
    { stripeSessionId: session.id },
    { $setOnInsert: paymentDoc },
    { upsert: true }
  );

  // 2. Upgrade user document to Pro tier with exact validated dates
  if (userObjectId) {
    await users.updateOne(
      { _id: userObjectId },
      {
        $set: {
          "subscription.plan": "pro",
          "subscription.billingInterval": billingInterval,
          "subscription.status": subStatus,
          "subscription.stripeCustomerId":
            typeof session.customer === "string"
              ? session.customer
              : session.customer?.id ?? null,
          "subscription.stripeSubscriptionId": subscriptionId,
          "subscription.currentPeriodStart": currentPeriodStart,
          "subscription.currentPeriodEnd": currentPeriodEnd,
          "subscription.cancelAtPeriodEnd": cancelAtPeriodEnd,
          updatedAt: new Date(),
        },
      }
    );
  }

  return { ...paymentDoc, currentPeriodStart, currentPeriodEnd };
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

// Shared helper: syncs with Stripe, repairs dates, enforces expiration, and returns validated subscription
async function syncAndValidateSubscription(userObjId, rowsOverride = null) {
  const rows =
    rowsOverride ??
    (await payments
      .find({ userId: userObjId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray());

  const userDoc = await users.findOne(
    { _id: userObjId },
    { projection: { subscription: 1, usage: 1 } }
  );

  let subscription = userDoc?.subscription
    ? { ...userDoc.subscription }
    : {
        plan: "free",
        status: "none",
        billingInterval: null,
      };

  const latestPayment = rows[0] || null;
  const fallbackStart = toValidDate(latestPayment?.createdAt);
  let billingInterval =
    subscription.billingInterval || latestPayment?.billingInterval || null;

  // 1. Live Stripe synchronization if Stripe subscription ID exists
  if (subscription.stripeSubscriptionId && stripe) {
    try {
      const sub = await stripe.subscriptions.retrieve(
        subscription.stripeSubscriptionId
      );
      const stripeInterval = sub?.items?.data?.[0]?.price?.recurring?.interval;
      if (!billingInterval && stripeInterval) {
        billingInterval = stripeInterval === "year" ? "yearly" : "monthly";
      }

      const { currentPeriodStart: subPeriodStart, currentPeriodEnd: subPeriodEnd } =
        extractSubscriptionPeriod(sub, fallbackStart, billingInterval || "monthly");

      const isExpired = subPeriodEnd.getTime() <= Date.now();
      const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);

      let plan = "pro";
      let status = sub.status;

      if (isExpired) {
        plan = "free";
        status = "expired";
      } else if (sub.status === "canceled" || cancelAtPeriodEnd) {
        // Canceled or pending cancellation in Stripe: retain Pro until currentPeriodEnd!
        plan = "pro";
        status = "canceled";
      } else if (sub.status === "active" || sub.status === "trialing") {
        plan = "pro";
        status = "active";
      } else {
        plan = "free";
        status = sub.status || "none";
      }

      await users.updateOne(
        { _id: userObjId },
        {
          $set: {
            "subscription.plan": plan,
            "subscription.billingInterval": billingInterval,
            "subscription.status": status,
            "subscription.currentPeriodStart": subPeriodStart,
            "subscription.currentPeriodEnd": subPeriodEnd,
            "subscription.cancelAtPeriodEnd": cancelAtPeriodEnd,
            updatedAt: new Date(),
          },
        }
      );

      subscription = {
        ...subscription,
        plan,
        billingInterval,
        status,
        currentPeriodStart: subPeriodStart,
        currentPeriodEnd: subPeriodEnd,
        cancelAtPeriodEnd,
      };
    } catch (err) {
      console.warn("Stripe live sync in syncAndValidateSubscription:", err.message);
    }
  }

  // 2. Repair or backfill any invalid/missing dates in subscription
  const validStart = toValidDate(subscription.currentPeriodStart) || fallbackStart;
  let validEnd = toValidDate(subscription.currentPeriodEnd);

  if (!validEnd && validStart && billingInterval) {
    validEnd = calculateExactExpirationDate(validStart, billingInterval);
  }

  const hadCorruptedDates =
    (subscription.currentPeriodStart != null &&
      !toValidDate(subscription.currentPeriodStart)) ||
    (subscription.currentPeriodEnd != null &&
      !toValidDate(subscription.currentPeriodEnd));

  if (hadCorruptedDates && validStart && validEnd) {
    await users.updateOne(
      { _id: userObjId },
      {
        $set: {
          "subscription.currentPeriodStart": validStart,
          "subscription.currentPeriodEnd": validEnd,
          updatedAt: new Date(),
        },
      }
    );
  }

  // 3. Validate expiration date against current time
  if (validEnd && validEnd.getTime() <= Date.now()) {
    if (subscription.plan === "pro") {
      await users.updateOne(
        { _id: userObjId },
        {
          $set: {
            "subscription.plan": "free",
            "subscription.status": "expired",
            updatedAt: new Date(),
          },
        }
      );
      subscription.plan = "free";
      subscription.status = "expired";
    }
  }

  const isActivePro =
    subscription.plan === "pro" &&
    (!validEnd || validEnd.getTime() > Date.now()) &&
    (subscription.status === "active" ||
      subscription.status === "trialing" ||
      subscription.status === "canceled");

  return {
    rows,
    userDoc,
    isActivePro,
    validStart,
    validEnd,
    subscription: {
      plan: isActivePro ? "pro" : "free",
      billingInterval: billingInterval || null,
      status: subscription.status || "none",
      currentPeriodStart: toIsoOrNull(validStart),
      currentPeriodEnd: toIsoOrNull(validEnd),
      cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
      stripeSubscriptionId: subscription.stripeSubscriptionId || null,
    },
  };
}

function serializePublicSubscription(sub) {
  return {
    plan: sub.plan,
    billingInterval: sub.billingInterval,
    status: sub.status,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

// Current validated subscription status for the authenticated user
export async function getSubscriptionStatus(req, res) {
  const userObjId = toObjectId(req.user.id);
  const { subscription } = await syncAndValidateSubscription(userObjId);
  res.json({ subscription: serializePublicSubscription(subscription) });
}

// Payment history for the authenticated user, synced with Stripe and validated
export async function listUserPayments(req, res) {
  const userObjId = toObjectId(req.user.id);
  const { rows, userDoc, subscription } =
    await syncAndValidateSubscription(userObjId);

  res.json({
    subscription: serializePublicSubscription(subscription),
    usage: userDoc?.usage || req.user?.usage || {},
    payments: rows.map((p) => ({
      id: p._id.toString(),
      stripeSessionId: p.stripeSessionId,
      amount: p.amount,
      currency: p.currency,
      planName: p.planName,
      billingInterval: p.billingInterval,
      status: p.status,
      createdAt: toIsoOrNull(p.createdAt) || new Date().toISOString(),
    })),
  });
}

// Schedule subscription cancellation at the end of the current paid billing period
export async function cancelSubscription(req, res) {
  const userObjId = toObjectId(req.user.id);
  const { isActivePro, validEnd, subscription } =
    await syncAndValidateSubscription(userObjId);

  if (!isActivePro) {
    return res.status(400).json({
      error: "No active Pro subscription found to cancel.",
    });
  }

  if (subscription.cancelAtPeriodEnd || subscription.status === "canceled") {
    return res.status(409).json({
      error:
        "Cancellation is already scheduled for the end of your current billing period.",
    });
  }

  let updatedPeriodEnd = validEnd;

  if (subscription.stripeSubscriptionId && stripe) {
    try {
      const updatedSub = await stripe.subscriptions.update(
        subscription.stripeSubscriptionId,
        { cancel_at_period_end: true }
      );
      const { currentPeriodEnd } = extractSubscriptionPeriod(
        updatedSub,
        subscription.currentPeriodStart,
        subscription.billingInterval || "monthly"
      );
      updatedPeriodEnd = currentPeriodEnd;
    } catch (err) {
      console.error("Failed to cancel Stripe subscription:", err?.message || err);
      return res.status(502).json({
        error: "Could not schedule cancellation with Stripe. Please try again.",
      });
    }
  }

  await users.updateOne(
    { _id: userObjId },
    {
      $set: {
        "subscription.plan": "pro",
        "subscription.status": "canceled",
        "subscription.cancelAtPeriodEnd": true,
        ...(updatedPeriodEnd ? { "subscription.currentPeriodEnd": updatedPeriodEnd } : {}),
        updatedAt: new Date(),
      },
    }
  );

  const updatedSubscription = {
    ...subscription,
    plan: "pro",
    status: "canceled",
    cancelAtPeriodEnd: true,
    currentPeriodEnd: toIsoOrNull(updatedPeriodEnd),
  };

  res.json({
    message:
      "Your subscription renewal has been canceled. You will retain Pro access until the end of your current billing period.",
    subscription: serializePublicSubscription(updatedSubscription),
  });
}

// Reactivate a pending-cancellation subscription before its paid period expires
export async function reactivateSubscription(req, res) {
  const userObjId = toObjectId(req.user.id);
  const { isActivePro, subscription } =
    await syncAndValidateSubscription(userObjId);

  if (!isActivePro) {
    return res.status(400).json({
      error:
        "Your subscription has already expired. Please choose a plan to subscribe again.",
    });
  }

  if (!subscription.cancelAtPeriodEnd && subscription.status !== "canceled") {
    return res.status(409).json({
      error: "Your subscription is already active and not scheduled for cancellation.",
    });
  }

  if (subscription.stripeSubscriptionId && stripe) {
    try {
      const currentSub = await stripe.subscriptions.retrieve(
        subscription.stripeSubscriptionId
      );
      if (currentSub.status === "canceled") {
        return res.status(400).json({
          error:
            "This subscription has already been finalized in Stripe and cannot be reactivated. You can purchase a new plan after your current period expires.",
        });
      }
      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });
    } catch (err) {
      console.error("Failed to reactivate Stripe subscription:", err?.message || err);
      return res.status(502).json({
        error: "Could not reactivate subscription with Stripe. Please try again.",
      });
    }
  }

  await users.updateOne(
    { _id: userObjId },
    {
      $set: {
        "subscription.plan": "pro",
        "subscription.status": "active",
        "subscription.cancelAtPeriodEnd": false,
        updatedAt: new Date(),
      },
    }
  );

  const updatedSubscription = {
    ...subscription,
    plan: "pro",
    status: "active",
    cancelAtPeriodEnd: false,
  };

  res.json({
    message:
      "Your subscription has been reactivated. Your existing plan will continue without interruption.",
    subscription: serializePublicSubscription(updatedSubscription),
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
        const stripeInterval = sub?.items?.data?.[0]?.price?.recurring?.interval;
        const billingInterval = stripeInterval === "year" ? "yearly" : "monthly";
        const { currentPeriodStart, currentPeriodEnd } = extractSubscriptionPeriod(
          sub,
          new Date(),
          billingInterval
        );
        const isExpired = currentPeriodEnd.getTime() <= Date.now();
        const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);

        let status =
          sub.status === "active" || sub.status === "trialing"
            ? "active"
            : sub.status === "past_due"
              ? "past_due"
              : "canceled";

        let plan = "pro";
        if (isExpired) {
          plan = "free";
          status = "expired";
        } else if (status === "canceled" || cancelAtPeriodEnd) {
          // If canceled or pending cancellation in Stripe, retain Pro until paid period ends!
          plan = "pro";
          status = "canceled";
        }

        await users.updateOne(
          { "subscription.stripeSubscriptionId": sub.id },
          {
            $set: {
              "subscription.plan": plan,
              "subscription.billingInterval": billingInterval,
              "subscription.status": status,
              "subscription.currentPeriodStart": currentPeriodStart,
              "subscription.currentPeriodEnd": currentPeriodEnd,
              "subscription.cancelAtPeriodEnd": cancelAtPeriodEnd,
              updatedAt: new Date(),
            },
          }
        );
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const stripeInterval = sub?.items?.data?.[0]?.price?.recurring?.interval;
        const billingInterval = stripeInterval === "year" ? "yearly" : "monthly";
        const { currentPeriodEnd } = extractSubscriptionPeriod(
          sub,
          new Date(),
          billingInterval
        );
        const isExpired = currentPeriodEnd.getTime() <= Date.now();

        await users.updateOne(
          { "subscription.stripeSubscriptionId": sub.id },
          {
            $set: {
              "subscription.plan": isExpired ? "free" : "pro",
              "subscription.status": isExpired ? "expired" : "canceled",
              "subscription.currentPeriodEnd": currentPeriodEnd,
              "subscription.cancelAtPeriodEnd": true,
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

// User routes
paymentsRouter.post("/checkout-verify", verifyCheckout);
paymentsRouter.get("/subscription", requireAuth, getSubscriptionStatus);
paymentsRouter.get("/history", requireAuth, listUserPayments);
paymentsRouter.post("/cancel", requireAuth, cancelSubscription);
paymentsRouter.post("/reactivate", requireAuth, reactivateSubscription);

export { paymentsRouter };
