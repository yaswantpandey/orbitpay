import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { createSplitSchema } from "./schemas";
import { parse, requireMoneyMover, audit, CALLABLE_OPTIONS } from "./middleware";
import { REQUEST_TTL_MS } from "./requests";

/**
 * Split a bill: one payment request per participant, tagged with a shared splitId.
 * Payment goes through the normal respondRequest flow; progress is derived from those requests.
 */
export const createSplit = onCall(CALLABLE_OPTIONS, async (req) => {
  const input = parse(createSplitSchema, req.data);
  const { uid, user, limits } = await requireMoneyMover(req);
  const db = getFirestore();

  const shares = input.shares.map((s) => ({ email: s.email.toLowerCase(), amountCents: s.amountCents }));
  const emails = new Set(shares.map((s) => s.email));
  if (emails.size !== shares.length) throw new HttpsError("invalid-argument", "Each person can appear only once");
  if (emails.has(user.email)) throw new HttpsError("invalid-argument", "Don't include yourself; your share is the remainder");
  const requested = shares.reduce((s, x) => s + x.amountCents, 0);
  if (requested > input.totalCents) throw new HttpsError("invalid-argument", "Shares add up to more than the total");
  if (shares.some((s) => s.amountCents > limits.perTransaction)) {
    throw new HttpsError("resource-exhausted", "A share exceeds the per-transaction limit");
  }

  const payers = await Promise.all(shares.map((s) =>
    db.collection("users").where("email", "==", s.email).limit(1).get()));
  const missing = shares.filter((_, i) => payers[i].empty).map((s) => s.email);
  if (missing.length) throw new HttpsError("not-found", `No OrbitPay account for ${missing.join(", ")}`);

  const splitRef = db.collection("splits").doc();
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();
  const expiresAt = Timestamp.fromMillis(Date.now() + REQUEST_TTL_MS);
  const note = `Split: ${input.title}`.slice(0, 200);
  const requestIds: string[] = [];

  shares.forEach((s, i) => {
    const payerUid = payers[i].docs[0].id;
    const ref = db.collection("paymentRequests").doc();
    requestIds.push(ref.id);
    batch.set(ref, {
      requesterUid: uid, requesterEmail: user.email, payerUid, payerEmail: s.email,
      participants: [uid, payerUid], amountCents: s.amountCents, note, status: "pending",
      splitId: splitRef.id, expiresAt, createdAt: now,
    });
    batch.set(db.doc(`notifications/${ref.id}_req`), {
      uid: payerUid, kind: "request", amountCents: s.amountCents, fromEmail: user.email,
      note, read: false, createdAt: now,
    });
  });
  batch.set(splitRef, {
    ownerUid: uid, title: input.title, totalCents: input.totalCents,
    ownShareCents: input.totalCents - requested, shares, requestIds, createdAt: now,
  });
  await batch.commit();
  await audit(uid, "split.created", { splitId: splitRef.id, totalCents: input.totalCents, people: shares.length });
  return { splitId: splitRef.id, requestIds };
});
