import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { createPotSchema, potMoveSchema, potIdSchema } from "./schemas";
import { parse, requireAuth, requireMoneyMover, audit, CALLABLE_OPTIONS } from "./middleware";

const MAX_POTS = 20;

export const createPot = onCall(CALLABLE_OPTIONS, async (req) => {
  const { name, targetCents } = parse(createPotSchema, req.data);
  const uid = requireAuth(req);
  const db = getFirestore();
  const count = (await db.collection("pots").where("uid", "==", uid).count().get()).data().count;
  if (count >= MAX_POTS) throw new HttpsError("resource-exhausted", `You can have up to ${MAX_POTS} goals`);
  const ref = db.collection("pots").doc();
  await ref.set({ uid, name: name.trim(), targetCents, balanceCents: 0, createdAt: FieldValue.serverTimestamp() });
  return { potId: ref.id };
});

/**
 * Move money between the USD wallet and a savings pot in one transaction.
 * Pot money is not spendable: it isn't in wallets/{uid}.balanceCents.
 */
export async function movePot(uid: string, potId: string, direction: "in" | "out", amountCents: number, key: string) {
  const db = getFirestore();
  const moveId = `${uid}_${key}`;
  const potRef = db.doc(`pots/${potId}`);
  const walletRef = db.doc(`wallets/${uid}`);
  const markerRef = db.doc(`ledger/${moveId}`);
  return db.runTransaction(async (tx) => {
    if ((await tx.get(markerRef)).exists) return { replayed: true };
    const [pot, wallet] = await Promise.all([tx.get(potRef), tx.get(walletRef)]);
    if (!pot.exists || pot.data()!.uid !== uid) throw new HttpsError("not-found", "Goal not found");
    const potBal = pot.data()!.balanceCents as number;
    const walBal = wallet.data()!.balanceCents as number;
    if (direction === "in" && walBal < amountCents) throw new HttpsError("failed-precondition", "Insufficient funds");
    if (direction === "out" && potBal < amountCents) throw new HttpsError("failed-precondition", "Not enough in this goal");
    const sign = direction === "in" ? -1 : 1;
    const walAfter = walBal + sign * amountCents;
    const now = FieldValue.serverTimestamp();
    tx.update(walletRef, { balanceCents: walAfter, version: FieldValue.increment(1), updatedAt: now });
    tx.update(potRef, { balanceCents: potBal - sign * amountCents, updatedAt: now });
    tx.set(markerRef, {
      txId: moveId, uid, type: direction === "in" ? "savings_in" : "savings_out", amountCents: sign * amountCents,
      balanceAfterCents: walAfter, potId, note: `${direction === "in" ? "To" : "From"} goal: ${pot.data()!.name}`, createdAt: now,
    });
    return { replayed: false };
  });
}

export const movePotFunds = onCall(CALLABLE_OPTIONS, async (req) => {
  const input = parse(potMoveSchema, req.data);
  // Moving into savings is still a money movement (frozen/KYC rules apply); moving out is always allowed.
  let uid: string;
  if (input.direction === "in") {
    const mover = await requireMoneyMover(req);
    uid = mover.uid;
    if (input.amountCents > mover.limits.perTransaction) {
      throw new HttpsError("resource-exhausted", "Amount exceeds per-transaction limit");
    }
  } else {
    uid = requireAuth(req);
  }
  const r = await movePot(uid, input.potId, input.direction, input.amountCents, input.idempotencyKey);
  if (!r.replayed) await audit(uid, `pot.${input.direction}`, { potId: input.potId, amountCents: input.amountCents });
  return { ok: true };
});

export const deletePot = onCall(CALLABLE_OPTIONS, async (req) => {
  const { potId } = parse(potIdSchema, req.data);
  const uid = requireAuth(req);
  const db = getFirestore();
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`pots/${potId}`);
    const p = (await tx.get(ref)).data();
    if (!p || p.uid !== uid) throw new HttpsError("not-found", "Goal not found");
    if (p.balanceCents > 0) throw new HttpsError("failed-precondition", "Move the money out before deleting this goal");
    tx.delete(ref);
  });
  return { ok: true };
});
