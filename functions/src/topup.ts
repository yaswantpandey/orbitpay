import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import Stripe from "stripe";
import { topupSchema } from "./schemas";
import { parse, requireMoneyMover, audit, bumpStats, CALLABLE_OPTIONS } from "./middleware";

export const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
export const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const stripeClient = () => new Stripe(STRIPE_SECRET_KEY.value());

/** Creates a pending top-up and a Stripe PaymentIntent. Never credits the wallet. */
export const createTopup = onCall({ ...CALLABLE_OPTIONS, secrets: [STRIPE_SECRET_KEY] }, async (req) => {
  const input = parse(topupSchema, req.data);
  const { uid, limits } = await requireMoneyMover(req);
  if (input.amountCents > limits.perTransaction) {
    throw new HttpsError("resource-exhausted", "Amount exceeds per-transaction limit");
  }
  const db = getFirestore();
  const topupId = `${uid}_${input.idempotencyKey}`;
  const ref = db.doc(`topups/${topupId}`);

  const existing = await ref.get();
  if (existing.exists) {
    const pi = await stripeClient().paymentIntents.retrieve(existing.data()!.stripePaymentIntentId);
    return { topupId, clientSecret: pi.client_secret };
  }

  const pi = await stripeClient().paymentIntents.create(
    {
      amount: input.amountCents,
      currency: "usd",
      payment_method_types: input.method === "card" ? ["card"] : ["us_bank_account"],
      metadata: { uid, topupId },
    },
    { idempotencyKey: topupId }
  );

  await ref.set({
    uid,
    stripePaymentIntentId: pi.id,
    method: input.method,
    amountCents: input.amountCents,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  });
  await audit(uid, "topup.created", { topupId, amountCents: input.amountCents });
  return { topupId, clientSecret: pi.client_secret };
});

/** Credits the wallet only from a signature-verified Stripe event. Idempotent per top-up. */
export const stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    let event: Stripe.Event;
    try {
      event = stripeClient().webhooks.constructEvent(
        req.rawBody,
        req.headers["stripe-signature"] as string,
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      logger.warn("Invalid Stripe signature", err);
      res.status(400).send("Invalid signature");
      return;
    }

    const db = getFirestore();
    const eventRef = db.doc(`stripeEvents/${event.id}`);
    const alreadyProcessed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(eventRef);
      if (snap.exists && snap.data()?.status === "completed") return true;
      tx.set(eventRef, { type: event.type, status: "processing", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return false;
    });
    if (alreadyProcessed) {
      res.status(200).send("duplicate");
      return;
    }

    if (event.type.startsWith("charge.dispute.")) {
      const dispute = event.data.object as Stripe.Dispute;
      const piId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.charge;
      if (piId) {
        const topupQuery = await db.collection("topups").where("stripePaymentIntentId", "==", piId).limit(1).get();
        if (!topupQuery.empty) {
          const topupDoc = topupQuery.docs[0];
          const topup = topupDoc.data();
          await topupDoc.ref.update({
            disputed: event.type === "charge.dispute.created",
            disputeStatus: dispute.status,
            disputeReason: dispute.reason ?? null,
            updatedAt: FieldValue.serverTimestamp(),
          });
          await audit(topup.uid, "topup.dispute", {
            disputeId: dispute.id,
            status: dispute.status,
            reason: dispute.reason,
            topupId: topupDoc.id,
          });
          await db.doc(`notifications/dispute_${dispute.id}`).set({
            uid: topup.uid,
            kind: "hold",
            amountCents: dispute.amount,
            fromEmail: "OrbitPay Security",
            note: `Payment dispute opened: ${dispute.reason || "Under review"}`,
            read: false,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
      }
      await eventRef.update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
    res.status(200).send("ok");
      return;
    }
    if (event.type.startsWith("identity.verification_session.")) {
      // Lazy import avoids a circular module dependency (kyc.ts imports STRIPE_SECRET_KEY from here).
      const { handleIdentityEvent } = await import("./kyc");
      await handleIdentityEvent(event);
      await eventRef.update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
    res.status(200).send("ok");
      return;
    }
    const pi = event.data.object as Stripe.PaymentIntent;
    const topupId = pi.metadata?.topupId;
    if (!topupId) {
      res.status(200).send("ignored");
      return;
    }
    const topupRef = db.doc(`topups/${topupId}`);

    if (event.type === "payment_intent.succeeded") {
      await db.runTransaction(async (tx) => {
        const topupSnap = await tx.get(topupRef);
        if (!topupSnap.exists) throw new Error(`Unknown topup ${topupId}`);
        const topup = topupSnap.data()!;
        if (topup.status === "completed") return; // duplicate delivery
        if (pi.amount_received !== topup.amountCents) throw new Error("Amount mismatch");

        const walletRef = db.doc(`wallets/${topup.uid}`);
        const walletSnap = await tx.get(walletRef);
        const after = (walletSnap.data()!.balanceCents as number) + topup.amountCents;
        const now = FieldValue.serverTimestamp();

        tx.update(walletRef, { balanceCents: after, version: FieldValue.increment(1), updatedAt: now });
        bumpStats(tx, topup.uid, "inCents", topup.amountCents);
        tx.update(topupRef, { status: "completed", completedAt: now });
        tx.set(db.doc(`ledger/${topupId}_topup`), {
          txId: topupId, uid: topup.uid, type: "topup", amountCents: topup.amountCents,
          balanceAfterCents: after, note: `${topup.method} top-up`, createdAt: now,
        });
        // Platform totals for reconciliation invariant.
        tx.set(db.doc("system/totals"), { receivedCents: FieldValue.increment(topup.amountCents) }, { merge: true });
      });
    } else if (event.type === "payment_intent.processing") {
      // ACH debits take days to clear; keep the top-up pending but show it as processing.
      await setStatusUnlessDone(topupRef, "processing");
    } else if (event.type === "payment_intent.payment_failed" || event.type === "payment_intent.canceled") {
      await setStatusUnlessDone(topupRef, "failed", pi.last_payment_error?.message ?? event.type);
    }
    await eventRef.update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
    res.status(200).send("ok");
  }
);

/** Out-of-order webhook deliveries must never downgrade a completed top-up. */
async function setStatusUnlessDone(ref: FirebaseFirestore.DocumentReference, status: string, failureReason?: string) {
  await getFirestore().runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || cur.status === "completed" || cur.status === "failed") return;
    tx.update(ref, { status, ...(failureReason ? { failureReason } : {}), updatedAt: FieldValue.serverTimestamp() });
  });
}
