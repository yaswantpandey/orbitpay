/**
 * Ledger and Transfer Engine Invariant Tests.
 * Run against the Firestore emulator (npm run test:ledger).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import { executeTransfer, TransferInput, computePayloadHash } from "./transfer";
import { transferSchema, idempotencyKeySchema, noteSchema, amountCentsSchema } from "./schemas";

let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run with the Firestore emulator");
  if (getApps().length === 0) initializeApp({ projectId: "demo-fastpay" });
  db = getFirestore();
});

async function clear() {
  for (const c of ["wallets", "ledger", "transfers", "dailyTotals", "notifications", "paymentRequests"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function seed(balances: Record<string, number>) {
  await Promise.all(
    Object.entries(balances).map(([uid, balanceCents]) =>
      db.doc(`wallets/${uid}`).set({ balanceCents, currency: "USD", version: 0 })
    )
  );
}

const bal = async (uid: string) => (await db.doc(`wallets/${uid}`).get()).data()!.balanceCents as number;

const input = (o: Partial<TransferInput> = {}): TransferInput => ({
  fromUid: "alice", toUid: "bob", fromEmail: "alice@example.com", toEmail: "bob@example.com",
  amountCents: 1_000, note: "Dinner", idempotencyKey: randomUUID(), perDayLimit: 1_000_000, ...o,
});

describe("executeTransfer Core Engine", () => {
  beforeEach(async () => {
    await clear();
    await seed({ alice: 10_000, bob: 0 });
  });

  it("moves funds and writes exactly one debit and one equal credit", async () => {
    const { txId } = await executeTransfer(db, input({ amountCents: 2_500 }));
    expect(await bal("alice")).toBe(7_500);
    expect(await bal("bob")).toBe(2_500);

    const entries = (await db.collection("ledger").where("txId", "==", txId).get()).docs.map((d) => d.data());
    expect(entries).toHaveLength(2);
    expect(entries.reduce((s, e) => s + e.amountCents, 0)).toBe(0);
  });

  it("never creates a second transfer when the idempotency key is replayed with same payload", async () => {
    const key = randomUUID();
    await executeTransfer(db, input({ idempotencyKey: key, amountCents: 1_000, note: "Test" }));
    const second = await executeTransfer(db, input({ idempotencyKey: key, amountCents: 1_000, note: "Test" }));
    expect(second.replayed).toBe(true);
    expect(await bal("alice")).toBe(9_000);
    expect((await db.collection("transfers").get()).size).toBe(1);
  });

  it("throws when idempotency key is replayed with a different payload", async () => {
    const key = randomUUID();
    await executeTransfer(db, input({ idempotencyKey: key, amountCents: 1_000, note: "Original" }));

    // Replay with different amount
    await expect(
      executeTransfer(db, input({ idempotencyKey: key, amountCents: 2_000, note: "Original" }))
    ).rejects.toThrow(/different transfer parameters/);

    // Replay with different note
    await expect(
      executeTransfer(db, input({ idempotencyKey: key, amountCents: 1_000, note: "Altered Note" }))
    ).rejects.toThrow(/different transfer parameters/);

    // Replay with different recipient
    await expect(
      executeTransfer(db, input({ idempotencyKey: key, toUid: "charlie", amountCents: 1_000, note: "Original" }))
    ).rejects.toThrow(/different transfer parameters/);

    // Balance and transfer count remain unchanged
    expect(await bal("alice")).toBe(9_000);
    expect((await db.collection("transfers").get()).size).toBe(1);
  });

  it("handles 10 concurrent same-key calls by executing exactly once", async () => {
    const key = randomUUID();
    const calls = Array.from({ length: 10 }, () =>
      executeTransfer(db, input({ idempotencyKey: key, amountCents: 1_500 }))
    );
    const results = await Promise.all(calls);
    const realTransfers = results.filter((r) => !r.replayed);
    const replayedTransfers = results.filter((r) => r.replayed);

    expect(realTransfers).toHaveLength(1);
    expect(replayedTransfers).toHaveLength(9);
    expect(await bal("alice")).toBe(8_500);
    expect(await bal("bob")).toBe(1_500);

    const ledgerDocs = await db.collection("ledger").where("txId", "==", realTransfers[0].txId).get();
    expect(ledgerDocs.size).toBe(2);
  });

  it("rejects insufficient funds and never goes negative", async () => {
    await expect(executeTransfer(db, input({ amountCents: 10_001 }))).rejects.toThrow(/Insufficient/);
    expect(await bal("alice")).toBe(10_000);
  });

  it("prevents overspending under concurrent different-key transfers exceeding balance", async () => {
    await seed({ alice: 5_000, bob: 0 });
    // 10 concurrent transfers of 1,000 each (total 10,000 > 5,000 balance)
    const calls = Array.from({ length: 10 }, () =>
      executeTransfer(db, input({ amountCents: 1_000, idempotencyKey: randomUUID() }))
    );
    const results = await Promise.allSettled(calls);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    expect(await bal("alice")).toBe(0);
    expect(await bal("bob")).toBe(5_000);
  });

  it("enforces the daily limit at exact boundary", async () => {
    // Limit is 5,000
    // Transfer 4,999: succeeds
    await executeTransfer(db, input({ amountCents: 4_999, perDayLimit: 5_000 }));
    expect(await bal("alice")).toBe(5_001);

    // Transfer 2: exceeds 5,000 limit (4,999 + 2 = 5,001) -> rejected
    await expect(
      executeTransfer(db, input({ amountCents: 2, perDayLimit: 5_000 }))
    ).rejects.toThrow(/Daily limit/);

    // Transfer 1: exactly hits 5,000 limit (4,999 + 1 = 5,000) -> succeeds
    await executeTransfer(db, input({ amountCents: 1, perDayLimit: 5_000 }));
    expect(await bal("alice")).toBe(5_000);

    // Any further transfer rejected
    await expect(
      executeTransfer(db, input({ amountCents: 1, perDayLimit: 5_000 }))
    ).rejects.toThrow(/Daily limit/);
  });

  it("guards against corrupt or missing balanceCents in wallet", async () => {
    await db.doc("wallets/corrupt").set({ currency: "USD" }); // missing balanceCents
    await expect(
      executeTransfer(db, input({ fromUid: "corrupt", amountCents: 100 }))
    ).rejects.toThrow(/Corrupt wallet balance state/);
  });

  it("conserves total funds under concurrent bidirectional transfers", async () => {
    await seed({ alice: 10_000, bob: 10_000 });
    const ops = Array.from({ length: 20 }, (_, i) =>
      executeTransfer(db, i % 2
        ? input({ amountCents: 700 })
        : input({ fromUid: "bob", toUid: "alice", fromEmail: "bob@example.com", toEmail: "alice@example.com", amountCents: 900 })
      ).catch(() => null)
    );
    await Promise.all(ops);
    const a = await bal("alice");
    const b = await bal("bob");
    expect(a + b).toBe(20_000);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
  });

  it("settles a request exactly once even when paid twice concurrently", async () => {
    const ref = db.doc("paymentRequests/r1");
    await ref.set({ payerUid: "alice", status: "pending" });
    const hook = {
      ref,
      check: (cur: FirebaseFirestore.DocumentData | undefined) => {
        if (cur?.status !== "pending") throw new Error(`Request is ${cur?.status}`);
      },
      update: { status: "paid" },
    };
    const pay = () => executeTransfer(db, input({ amountCents: 4_000, idempotencyKey: "req_r1_settle" }), hook);
    const results = await Promise.all([pay(), pay()]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await bal("alice")).toBe(6_000);
    expect((await ref.get()).data()!.status).toBe("paid");
  });

  it("does not move money when the settle check fails", async () => {
    const ref = db.doc("paymentRequests/r2");
    await ref.set({ status: "declined" });
    await expect(executeTransfer(db, input(), {
      ref,
      check: (cur) => { if (cur?.status !== "pending") throw new Error("Request is declined"); },
      update: { status: "paid" },
    })).rejects.toThrow(/declined/);
    expect(await bal("alice")).toBe(10_000);
  });
});

describe("Transfer and Idempotency Schemas Validation", () => {
  it("validates idempotency keys with ^[A-Za-z0-9_-]{16,64}$", () => {
    // Valid keys: UUIDs, alphanumeric tokens
    expect(idempotencyKeySchema.safeParse(randomUUID()).success).toBe(true);
    expect(idempotencyKeySchema.safeParse("a".repeat(16)).success).toBe(true);
    expect(idempotencyKeySchema.safeParse("A_B-1234567890_cd").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("a".repeat(64)).success).toBe(true);

    // Invalid keys: too short (<16)
    expect(idempotencyKeySchema.safeParse("too_short").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("a".repeat(15)).success).toBe(false);

    // Invalid keys: too long (>64)
    expect(idempotencyKeySchema.safeParse("a".repeat(65)).success).toBe(false);

    // Invalid characters: spaces, slashes, dots, symbols
    expect(idempotencyKeySchema.safeParse("key with spaces 123456").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("../path/traversal/1234").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("key.with.dots.12345678").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("key@domain.com_123456").success).toBe(false);
  });

  it("strips control characters and enforces length on notes", () => {
    const clean = noteSchema.parse("Dinner with Alice\x00\x1f\x7f");
    expect(clean).toBe("Dinner with Alice");

    // Rejects notes exceeding 200 chars
    expect(noteSchema.safeParse("a".repeat(201)).success).toBe(false);
    expect(noteSchema.safeParse("a".repeat(200)).success).toBe(true);
  });

  it("enforces positive integer cents with upper bound on amount", () => {
    expect(amountCentsSchema.safeParse(1).success).toBe(true);
    expect(amountCentsSchema.safeParse(10_000).success).toBe(true);
    expect(amountCentsSchema.safeParse(1_000_000).success).toBe(true);

    // Invalid amounts
    expect(amountCentsSchema.safeParse(0).success).toBe(false);
    expect(amountCentsSchema.safeParse(-100).success).toBe(false);
    expect(amountCentsSchema.safeParse(12.5).success).toBe(false);
    expect(amountCentsSchema.safeParse(NaN).success).toBe(false);
    expect(amountCentsSchema.safeParse(Infinity).success).toBe(false);
    expect(amountCentsSchema.safeParse(1_000_001).success).toBe(false);
  });

  it("normalizes recipient email to lowercase and trims whitespace", () => {
    const parsed = transferSchema.parse({
      toEmail: "  ALICE@Example.COM  ",
      amountCents: 1_000,
      note: "Rent",
      idempotencyKey: "1234567890abcdef1234",
    });
    expect(parsed.toEmail).toBe("alice@example.com");
  });

  it("computes deterministic SHA-256 payload hashes", () => {
    const h1 = computePayloadHash("bob", 1000, "Dinner");
    const h2 = computePayloadHash("bob", 1000, "Dinner");
    const h3 = computePayloadHash("bob", 1001, "Dinner");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toHaveLength(64);
  });
});
