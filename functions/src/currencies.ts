import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { convertSchema } from "./schemas";
import { parse, requireMoneyMover, audit } from "./middleware";

export const SPREAD = 0.005; // 0.5% kept by OrbitPay on every conversion
const MAX_RATE_AGE_MS = 24 * 60 * 60 * 1000;
const DECIMALS: Record<string, number> = { JPY: 0 };
export const decimals = (c: string) => DECIMALS[c] ?? 2;

/** Rate for 1 unit of `from` in `to`, from the USD-based table (USD itself is 1). */
export function crossRate(rates: Record<string, number>, from: string, to: string) {
  const r = (c: string) => (c === "USD" ? 1 : rates[c]);
  if (!r(from) || !r(to)) throw new HttpsError("unavailable", `No rate for ${!r(from) ? from : to}`);
  return r(to) / r(from);
}

/** Destination minor units after spread, rounded down so OrbitPay never pays out more than it took in. */
export function convertMinor(amountMinor: number, from: string, to: string, rate: number) {
  const major = amountMinor / 10 ** decimals(from);
  return Math.floor(major * rate * (1 - SPREAD) * 10 ** decimals(to) + 1e-9);
}

/** Balance doc for a currency: the USD wallet, or a per-currency sub-balance. */
const balanceRef = (uid: string, cur: string) =>
  cur === "USD" ? getFirestore().doc(`wallets/${uid}`) : getFirestore().doc(`balances/${uid}_${cur}`);
const field = (cur: string) => (cur === "USD" ? "balanceCents" : "balanceMinor");

export const convert = onCall(async (req) => {
  const input = parse(convertSchema, req.data);
  if (input.from === input.to) throw new HttpsError("invalid-argument", "Pick two different currencies");
  const { uid, limits } = await requireMoneyMover(req);
  const db = getFirestore();
  const convId = `${uid}_${input.idempotencyKey}`;
  const convRef = db.doc(`conversions/${convId}`);

  const result = await db.runTransaction(async (tx) => {
    const existing = await tx.get(convRef);
    if (existing.exists) return { ...(existing.data() as { toMinor: number; rate: number }), replayed: true };

    const fx = (await tx.get(db.doc("fxRates/latest"))).data();
    if (!fx) throw new HttpsError("unavailable", "Exchange rates unavailable");
    if (Date.now() - (fx.fetchedAt as Timestamp).toMillis() > MAX_RATE_AGE_MS) {
      throw new HttpsError("unavailable", "Exchange rates are out of date; try again shortly");
    }
    const rate = crossRate(fx.rates, input.from, input.to);
    const effective = rate * (1 - SPREAD);
    // Protect the user from a rate move between quote and confirm.
    if (effective < input.quotedRate * 0.99) throw new HttpsError("aborted", "The rate changed. Review the new quote.");

    const usdValueCents = Math.ceil((input.amountMinor / 10 ** decimals(input.from)) / crossRate(fx.rates, "USD", input.from) * 100);
    if (usdValueCents > limits.perTransaction) throw new HttpsError("resource-exhausted", "Amount exceeds per-transaction limit");

    const toMinor = convertMinor(input.amountMinor, input.from, input.to, rate);
    if (toMinor <= 0) throw new HttpsError("invalid-argument", "Amount too small to convert");

    const srcRef = balanceRef(uid, input.from);
    const dstRef = balanceRef(uid, input.to);
    const [src, dst] = await Promise.all([tx.get(srcRef), tx.get(dstRef)]);
    const srcBal = (src.data()?.[field(input.from)] as number | undefined) ?? 0;
    if (srcBal < input.amountMinor) throw new HttpsError("failed-precondition", "Insufficient funds");
    const dstBal = (dst.data()?.[field(input.to)] as number | undefined) ?? 0;
    const now = FieldValue.serverTimestamp();
    const srcAfter = srcBal - input.amountMinor;
    const dstAfter = dstBal + toMinor;

    for (const [ref, cur, after] of [[srcRef, input.from, srcAfter], [dstRef, input.to, dstAfter]] as const) {
      if (cur === "USD") tx.update(ref, { balanceCents: after, version: FieldValue.increment(1), updatedAt: now });
      else tx.set(ref, { uid, currency: cur, balanceMinor: after, updatedAt: now }, { merge: true });
    }
    const note = `${input.from} → ${input.to} @ ${effective.toFixed(6)}`;
    const entry = (cur: string, amountMinor: number, after: number, suffix: string) => {
      if (cur === "USD") {
        tx.set(db.doc(`ledger/${convId}_${suffix}`), {
          txId: convId, uid, type: amountMinor < 0 ? "fx_out" : "fx_in", amountCents: amountMinor,
          balanceAfterCents: after, note, createdAt: now,
        });
      } else {
        tx.set(db.doc(`currencyLedger/${convId}_${suffix}`), {
          txId: convId, uid, currency: cur, amountMinor, balanceAfterMinor: after, note, createdAt: now,
        });
      }
    };
    entry(input.from, -input.amountMinor, srcAfter, "out");
    entry(input.to, toMinor, dstAfter, "in");
    // Platform position per currency, for treasury reconciliation.
    tx.set(db.doc("system/fxPositions"), {
      [input.from]: FieldValue.increment(input.amountMinor), [input.to]: FieldValue.increment(-toMinor),
    }, { merge: true });
    const record = { uid, from: input.from, to: input.to, fromMinor: input.amountMinor, toMinor, rate: effective, createdAt: now };
    tx.set(convRef, record);
    return { toMinor, rate: effective, replayed: false };
  });

  if (!result.replayed) await audit(uid, "fx.convert", { convId, from: input.from, to: input.to, fromMinor: input.amountMinor, toMinor: result.toMinor });
  return { conversionId: convId, toMinor: result.toMinor, rate: result.rate };
});
