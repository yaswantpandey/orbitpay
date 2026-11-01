/**
 * Invariants for savings pots, fraud holds and currency conversion maths.
 * Runs against the Firestore emulator.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import { movePot } from "./pots";
import { placeHold, decideHold } from "./risk";
import { convertMinor, crossRate, SPREAD } from "./currencies";
import { signPayload, isSafePublicUrl, checkWebhookUrl } from "./merchant";
import { createHmac } from "crypto";
import type { TransferInput } from "./transfer";

let db: Firestore;
beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run with the Firestore emulator");
  if (getApps().length === 0) initializeApp({ projectId: "demo-fastpay" });
  db = getFirestore();
});

const COLLECTIONS = ["wallets", "ledger", "transfers", "dailyTotals", "notifications", "pots", "holds", "stats"];
async function reset(balances: Record<string, number>) {
  for (const c of COLLECTIONS) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await Promise.all(Object.entries(balances).map(([uid, balanceCents]) =>
    db.doc(`wallets/${uid}`).set({ balanceCents, currency: "USD", version: 0 })));
}
const bal = async (uid: string) => (await db.doc(`wallets/${uid}`).get()).data()!.balanceCents as number;
const ledgerSum = async (uid: string) =>
  (await db.collection("ledger").where("uid", "==", uid).get()).docs.reduce((s, d) => s + d.data().amountCents, 0);

describe("savings pots", () => {
  beforeEach(async () => {
    await reset({ alice: 10_000 });
    await db.doc("pots/p1").set({ uid: "alice", name: "Trip", targetCents: 50_000, balanceCents: 0 });
  });

  it("moves money in and out, and wallet + pot is conserved", async () => {
    await movePot("alice", "p1", "in", 4_000, randomUUID());
    await movePot("alice", "p1", "out", 1_500, randomUUID());
    const pot = (await db.doc("pots/p1").get()).data()!.balanceCents;
    expect(await bal("alice")).toBe(7_500);
    expect(pot).toBe(2_500);
    expect((await bal("alice")) + pot).toBe(10_000);
    expect(await ledgerSum("alice")).toBe(-2_500); // wallet ledger reflects money set aside
  });

  it("is idempotent per key and refuses overdrawing either side", async () => {
    const key = randomUUID();
    await Promise.all([movePot("alice", "p1", "in", 3_000, key), movePot("alice", "p1", "in", 3_000, key)]);
    expect(await bal("alice")).toBe(7_000);
    await expect(movePot("alice", "p1", "out", 3_001, randomUUID())).rejects.toThrow(/Not enough/);
    await expect(movePot("alice", "p1", "in", 7_001, randomUUID())).rejects.toThrow(/Insufficient/);
  });

  it("rejects someone else's pot", async () => {
    await db.doc("wallets/eve").set({ balanceCents: 5_000 });
    await expect(movePot("eve", "p1", "in", 100, randomUUID())).rejects.toThrow(/not found/);
  });
});

describe("fraud holds", () => {
  beforeEach(() => reset({ alice: 100_000, bob: 0 }));
  const t = (o: Partial<TransferInput> = {}): TransferInput => ({
    fromUid: "alice", toUid: "bob", fromEmail: "alice@x.com", toEmail: "bob@x.com",
    amountCents: 60_000, note: "rent", idempotencyKey: randomUUID(), perDayLimit: 1_000_000, ...o,
  });

  it("reserves sender funds without paying the recipient", async () => {
    await placeHold(t(), ["test"]);
    expect(await bal("alice")).toBe(40_000);
    expect(await bal("bob")).toBe(0);
  });

  it("approval pays the recipient exactly once and relabels the debit", async () => {
    const input = t();
    const { holdId } = await placeHold(input, ["test"]);
    const results = await Promise.allSettled([
      decideHold(holdId, "approve", "admin", "ok"), decideHold(holdId, "approve", "admin", "ok"),
    ]);
    // At most one real decision; a concurrent duplicate either replays or is refused.
    const real = results.filter((r) => r.status === "fulfilled" && !r.value.replayed);
    expect(real).toHaveLength(1);
    expect(await bal("alice")).toBe(40_000);
    expect(await bal("bob")).toBe(60_000);
    const out = (await db.doc(`ledger/${holdId}_hold`).get()).data()!;
    expect(out.type).toBe("transfer_out");
    expect((await ledgerSum("alice")) + (await ledgerSum("bob"))).toBe(0);
  });

  it("rejection refunds exactly once; approve-after-reject is refused", async () => {
    const { holdId } = await placeHold(t(), ["test"]);
    await Promise.allSettled([decideHold(holdId, "reject", "admin", "fraud"), decideHold(holdId, "reject", "admin", "fraud")]);
    await expect(decideHold(holdId, "approve", "admin", "oops")).rejects.toThrow(/rejected/);
    expect(await bal("alice")).toBe(100_000);
    expect(await bal("bob")).toBe(0);
    expect(await ledgerSum("alice")).toBe(0);
  });

  it("replaying the same key places one hold", async () => {
    const input = t();
    await Promise.all([placeHold(input, ["a"]), placeHold(input, ["a"])]);
    expect(await bal("alice")).toBe(40_000);
  });
});

describe("conversion maths", () => {
  const rates = { EUR: 0.9, JPY: 150, GBP: 0.8 };

  it("cross rates go through USD", () => {
    expect(crossRate(rates, "USD", "EUR")).toBeCloseTo(0.9);
    expect(crossRate(rates, "EUR", "GBP")).toBeCloseTo(0.8 / 0.9);
  });

  it("applies the spread and rounds down, handling zero-decimal currencies", () => {
    // $100.00 → EUR at 0.9 minus 0.5% = €89.55
    expect(convertMinor(10_000, "USD", "EUR", 0.9)).toBe(8_955);
    // $1.00 → JPY at 150 minus 0.5% = ¥149.25 → ¥149
    expect(convertMinor(100, "USD", "JPY", 150)).toBe(149);
    // ¥1000 → USD at 1/150 = $6.6667 * 0.995 = $6.633 → 663 cents
    expect(convertMinor(1_000, "JPY", "USD", 1 / 150)).toBe(663);
  });

  it("a round trip never creates money", () => {
    for (const amt of [1, 99, 12_345, 1_000_000]) {
      const eur = convertMinor(amt, "USD", "EUR", 0.9);
      const back = convertMinor(eur, "EUR", "USD", 1 / 0.9);
      expect(back).toBeLessThanOrEqual(amt);
      expect(back).toBeGreaterThanOrEqual(Math.floor(amt * (1 - SPREAD) ** 2) - 1);
    }
  });
});

describe("webhook signatures", () => {
  it("matches HMAC_SHA256(secret, t.body)", () => {
    const sig = signPayload("whsec_test", '{"a":1}', 1700000000);
    const expected = createHmac("sha256", "whsec_test").update('1700000000.{"a":1}').digest("hex");
    expect(sig).toBe(`t=1700000000,v1=${expected}`);
  });
});

describe("webhook SSRF protection", () => {
  it("rejects non-https URLs and private/internal hosts", async () => {
    expect(await isSafePublicUrl("http://evil.com/webhook")).toBe(false);
    expect(await isSafePublicUrl("https://localhost/webhook")).toBe(false);
    expect(await isSafePublicUrl("https://127.0.0.1/webhook")).toBe(false);
    expect(await isSafePublicUrl("https://10.0.0.1/webhook")).toBe(false);
    expect(await isSafePublicUrl("https://192.168.1.1/webhook")).toBe(false);
    expect(await isSafePublicUrl("https://169.254.169.254/webhook")).toBe(false);
    expect(await isSafePublicUrl("https://metadata.google.internal/computeMetadata")).toBe(false);
  });

  it("checkWebhookUrl validates format", () => {
    expect(() => checkWebhookUrl("invalid-url")).toThrow(/Invalid webhook URL format/);
    expect(() => checkWebhookUrl("")).not.toThrow();
  });
});
