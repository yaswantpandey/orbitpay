import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { createRequestSchema, respondRequestSchema } from "./schemas";
import { parse, requireAuth, requireMoneyMover, audit } from "./middleware";
import { executeTransfer } from "./transfer";

export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const createRequest = onCall(async (req) => {
  const input = parse(createRequestSchema, req.data);
  const { uid, user, limits } = await requireMoneyMover(req);
  const db = getFirestore();
  const payerEmail = input.payerEmail.toLowerCase();
  if (payerEmail === user.email) throw new HttpsError("invalid-argument", "Cannot request from yourself");
  if (input.amountCents > limits.perTransaction) {
    throw new HttpsError("resource-exhausted", "Amount exceeds per-transaction limit");
  }

  const payers = await db.collection("users").where("email", "==", payerEmail).limit(1).get();
  if (payers.empty) throw new HttpsError("not-found", "No OrbitPay user with that email");
  const payerUid = payers.docs[0].id;

  const ref = db.collection("paymentRequests").doc();
  const batch = db.batch();
  batch.set(ref, {
    requesterUid: uid,
    requesterEmail: user.email,
    payerUid,
    payerEmail,
    participants: [uid, payerUid],
    amountCents: input.amountCents,
    note: input.note ?? "",
    status: "pending",
    expiresAt: Timestamp.fromMillis(Date.now() + REQUEST_TTL_MS),
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`notifications/${ref.id}_req`), {
    uid: payerUid, kind: "request", amountCents: input.amountCents, fromEmail: user.email,
    note: input.note ?? "", read: false, createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  await audit(uid, "request.created", { requestId: ref.id, payerUid, amountCents: input.amountCents });
  return { requestId: ref.id };
});

export const respondRequest = onCall(async (req) => {
  const { requestId, action } = parse(respondRequestSchema, req.data);
  const db = getFirestore();
  const ref = db.doc(`paymentRequests/${requestId}`);
  const uid = requireAuth(req);

  const snap = await ref.get();
  const r = snap.data();
  if (!r || r.payerUid !== uid) throw new HttpsError("not-found", "Request not found");
  if (r.status === "pending" && (r.expiresAt as Timestamp).toMillis() < Date.now()) {
    await ref.update({ status: "expired" });
    throw new HttpsError("failed-precondition", "This request has expired");
  }

  if (action === "decline") {
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (cur?.status !== "pending") throw new HttpsError("failed-precondition", `Request is ${cur?.status}`);
      tx.update(ref, { status: "declined", respondedAt: FieldValue.serverTimestamp() });
    });
    await audit(uid, "request.declined", { requestId });
    return { status: "declined" };
  }

  const { user, limits } = await requireMoneyMover(req);
  if (r.amountCents > limits.perTransaction) {
    throw new HttpsError("resource-exhausted", "Amount exceeds per-transaction limit");
  }
  const result = await executeTransfer(
    db,
    {
      fromUid: uid,
      toUid: r.requesterUid,
      fromEmail: user.email,
      toEmail: r.requesterEmail,
      amountCents: r.amountCents,
      note: r.note || "Payment request",
      idempotencyKey: `req_${requestId}`,
      perDayLimit: limits.perDay,
    },
    {
      ref,
      check: (cur) => {
        if (cur?.payerUid !== uid) throw new HttpsError("permission-denied", "Only the payer can pay");
        if (cur.status !== "pending") throw new HttpsError("failed-precondition", `Request is ${cur.status}`);
      },
      update: { status: "paid" },
    }
  );
  if (!result.replayed) await audit(uid, "request.paid", { requestId, txId: result.txId });
  return { status: "paid", txId: result.txId };
});
