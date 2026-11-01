import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { holdDecisionSchema } from "./schemas";
import { parse, requireAdmin, audit, bumpStats, dayKey, CALLABLE_OPTIONS } from "./middleware";
import { executeTransfer, TransferInput, computePayloadHash } from "./transfer";

/** Tunable thresholds. Amounts in cents. */
export const RISK = {
  velocityWindowMs: 10 * 60_000,
  velocityMaxTransfers: 5,
  newAccountMs: 24 * 3600_000,
  newAccountMaxCents: 20_000, // $200
  newRecipientMaxCents: 50_000, // $500
};

export type RiskDecision = { action: "allow" | "hold" | "block"; reasons: string[] };

/**
 * Note on velocity limits:
 * Firestore transactions only support reading individual document references (tx.get(docRef)).
 * Aggregate queries (such as collection count() queries) cannot be executed inside a Firestore transaction.
 * Therefore, velocity is pre-evaluated immediately prior to the transaction, and the transactional
 * daily limit check (dailyTotals) enforces a hard atomic monetary cap inside the transaction.
 */
export async function evaluateTransferRisk(
  fromUid: string, user: FirebaseFirestore.DocumentData, toUid: string, amountCents: number
): Promise<RiskDecision> {
  const db = getFirestore();
  const since = Timestamp.fromMillis(Date.now() - RISK.velocityWindowMs);
  const [recent, recentHolds, prior, recipient] = await Promise.all([
    db.collection("transfers").where("fromUid", "==", fromUid).where("createdAt", ">=", since).count().get(),
    db.collection("holds").where("fromUid", "==", fromUid).where("createdAt", ">=", since).count().get(),
    db.collection("transfers").where("fromUid", "==", fromUid).where("toUid", "==", toUid).limit(1).get(),
    db.doc(`users/${toUid}`).get(),
  ]);

  const block: string[] = [];
  const hold: string[] = [];
  if (recent.data().count + recentHolds.data().count >= RISK.velocityMaxTransfers) {
    block.push(`More than ${RISK.velocityMaxTransfers} payments in ${RISK.velocityWindowMs / 60_000} minutes`);
  }
  if (recipient.data()?.frozen) block.push("Recipient account is unavailable");

  const created = (user.createdAt as Timestamp | undefined)?.toMillis() ?? 0;
  if (Date.now() - created < RISK.newAccountMs && amountCents > RISK.newAccountMaxCents) {
    hold.push("Large payment from a new account");
  }
  if (prior.empty && amountCents > RISK.newRecipientMaxCents) hold.push("Large first payment to a new recipient");

  if (block.length) return { action: "block", reasons: block };
  if (hold.length) return { action: "hold", reasons: hold };
  return { action: "allow", reasons: [] };
}

/**
 * Debit the sender into a hold pending admin review. Id matches the transfer id
 * (`${fromUid}_${key}`) so a retried request finds the hold instead of sending.
 */
export async function placeHold(t: TransferInput, reasons: string[]) {
  const db = getFirestore();
  const holdId = `${t.fromUid}_${t.idempotencyKey}`;
  const holdRef = db.doc(`holds/${holdId}`);
  const walletRef = db.doc(`wallets/${t.fromUid}`);
  const dailyRef = db.doc(`dailyTotals/${t.fromUid}_${dayKey()}`);
  const payloadHash = t.payloadHash ?? computePayloadHash(t.toUid, t.amountCents, t.note);

  // Fast-path for replayed holds
  const fastSnap = await holdRef.get();
  if (fastSnap.exists) {
    const data = fastSnap.data()!;
    if (data.payloadHash && data.payloadHash !== payloadHash) {
      throw new HttpsError("invalid-argument", "Idempotency key reused with different transfer parameters");
    }
    return { holdId, replayed: true };
  }

  return db.runTransaction(async (tx) => {
    const [existing, wallet, daily] = await Promise.all([tx.get(holdRef), tx.get(walletRef), tx.get(dailyRef)]);
    if (existing.exists) {
      const data = existing.data()!;
      if (data.payloadHash && data.payloadHash !== payloadHash) {
        throw new HttpsError("invalid-argument", "Idempotency key reused with different transfer parameters");
      }
      return { holdId, replayed: true };
    }
    const bal = wallet.data()?.balanceCents;
    if (typeof bal !== "number" || Number.isNaN(bal)) {
      throw new HttpsError("internal", "Corrupt wallet balance state");
    }
    if (bal < t.amountCents) throw new HttpsError("failed-precondition", "Insufficient funds");
    const sentToday = daily.exists ? (daily.data()?.sentCents as number) ?? 0 : 0;
    if (sentToday + t.amountCents > t.perDayLimit) throw new HttpsError("resource-exhausted", "Daily limit exceeded");
    const now = FieldValue.serverTimestamp();
    const after = bal - t.amountCents;
    tx.update(walletRef, { balanceCents: after, version: FieldValue.increment(1), updatedAt: now });
    tx.set(dailyRef, { sentCents: FieldValue.increment(t.amountCents) }, { merge: true });
    bumpStats(tx, t.fromUid, "outCents", t.amountCents);
    tx.set(db.doc(`ledger/${holdId}_hold`), {
      txId: holdId, uid: t.fromUid, type: "hold", amountCents: -t.amountCents, balanceAfterCents: after,
      counterpartyEmail: t.toEmail, note: "Held for review", createdAt: now,
    });
    tx.set(holdRef, { ...t, payloadHash, reasons, status: "held", createdAt: now });
    tx.set(db.doc(`notifications/${holdId}_hold`), {
      uid: t.fromUid, kind: "hold", amountCents: t.amountCents, fromEmail: t.toEmail,
      note: "Your payment is being reviewed for your security. We'll let you know shortly.", read: false, createdAt: now,
    });
    return { holdId, replayed: false };
  }, { maxAttempts: 15 });
}

/** Admin approves (pays the recipient) or rejects (refunds the sender). Exactly once; a repeat approve is a replay. */
export async function decideHold(holdId: string, decision: "approve" | "reject", adminUid: string, reason: string) {
  const db = getFirestore();
  const holdRef = db.doc(`holds/${holdId}`);
  const h = (await holdRef.get()).data();
  if (!h) throw new HttpsError("not-found", "Hold not found");
  const decided = { decidedBy: adminUid, decisionReason: reason, decidedAt: FieldValue.serverTimestamp() };

  if (decision === "approve") {
    const t = h as unknown as TransferInput;
    const r = await executeTransfer(db, { ...t, fromHoldEntryId: `${holdId}_hold` }, {
      ref: holdRef,
      check: (cur) => { if (cur?.status !== "held") throw new HttpsError("failed-precondition", `Hold is ${cur?.status}`); },
      update: { status: "approved", ...decided },
      stampPayment: false,
    });
    return { status: "approved" as const, replayed: r.replayed };
  }

  await db.runTransaction(async (tx) => {
    const cur = (await tx.get(holdRef)).data();
    if (cur?.status !== "held") throw new HttpsError("failed-precondition", `Hold is ${cur?.status}`);
    const walletRef = db.doc(`wallets/${h.fromUid}`);
    const bal = (await tx.get(walletRef)).data()?.balanceCents;
    if (typeof bal !== "number" || Number.isNaN(bal)) {
      throw new HttpsError("internal", "Corrupt wallet balance state");
    }
    const after = bal + h.amountCents;
    const now = FieldValue.serverTimestamp();
    tx.update(walletRef, { balanceCents: after, version: FieldValue.increment(1), updatedAt: now });
    bumpStats(tx, h.fromUid, "outCents", -h.amountCents);
    tx.set(db.doc(`ledger/${holdId}_release`), {
      txId: holdId, uid: h.fromUid, type: "refund", amountCents: h.amountCents, balanceAfterCents: after,
      counterpartyEmail: h.toEmail, note: "Payment declined after review — funds returned", createdAt: now,
    });
    tx.update(holdRef, { status: "rejected", ...decided });
    tx.set(db.doc(`notifications/${holdId}_rejected`), {
      uid: h.fromUid, kind: "hold", amountCents: h.amountCents, fromEmail: h.toEmail,
      note: "Your payment couldn't be completed and the funds were returned.", read: false, createdAt: now,
    });
  });
  return { status: "rejected" as const, replayed: false };
}

export const adminDecideHold = onCall(CALLABLE_OPTIONS, async (req) => {
  const adminUid = requireAdmin(req);
  const { holdId, decision, reason } = parse(holdDecisionSchema, req.data);
  const r = await decideHold(holdId, decision, adminUid, reason);
  if (!r.replayed) await audit(adminUid, `admin.hold_${decision}`, { holdId, reason }, req.rawRequest.ip ?? "");
  return { status: r.status };
});

export const adminListHolds = onCall(CALLABLE_OPTIONS, async (req) => {
  requireAdmin(req);
  const snap = await getFirestore().collection("holds").where("status", "==", "held").orderBy("createdAt", "asc").limit(100).get();
  return {
    holds: snap.docs.map((d) => {
      const h = d.data();
      return { holdId: d.id, fromEmail: h.fromEmail, toEmail: h.toEmail, amountCents: h.amountCents, note: h.note,
        reasons: h.reasons, createdAt: h.createdAt?.toMillis?.() ?? null };
    }),
  };
});
