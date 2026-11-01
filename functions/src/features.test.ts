/**
 * Invariant tests for payouts, recurring schedules, admin reversals and stats.
 * Runs against the Firestore emulator (npm run test:ledger).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore, Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import { executeTransfer, TransferInput } from "./transfer";
import { holdFunds, markPaid, failPayout } from "./payouts";
import { nextRun, runSchedule } from "./schedules";
import { monthKey } from "./middleware";

let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run with the Firestore emulator");
  if (getApps().length === 0) initializeApp({ projectId: "demo-fastpay" });
  db = getFirestore();
});

const COLLECTIONS = ["wallets", "ledger", "transfers", "dailyTotals", "notifications", "payouts", "schedules", "users", "stats", "system"];
async function reset(balances: Record<string, number>) {
  for (const c of COLLECTIONS) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await Promise.all(Object.entries(balances).flatMap(([uid, balanceCents]) => [
    db.doc(`wallets/${uid}`).set({ balanceCents, currency: "USD", version: 0 }),
    db.doc(`users/${uid}`).set({ email: `${uid}@x.com`, kycStatus: "verified", tier: 1 }),
  ]));
}

const bal = async (uid: string) => (await db.doc(`wallets/${uid}`).get()).data()!.balanceCents as number;
const ledgerSum = async (uid: string) =>
  (await db.collection("ledger").where("uid", "==", uid).get()).docs.reduce((s, d) => s + d.data().amountCents, 0);
const input = (o: Partial<TransferInput> = {}): TransferInput => ({
  fromUid: "alice", toUid: "bob", fromEmail: "alice@x.com", toEmail: "bob@x.com",
  amountCents: 1_000, note: "", idempotencyKey: randomUUID(), perDayLimit: 1_000_000, ...o,
});

describe("payouts", () => {
  beforeEach(() => reset({ alice: 10_000 }));

  it("holds funds immediately and only once per key", async () => {
    const [a, b] = await Promise.all([holdFunds("alice", "p1", 4_000, "acct"), holdFunds("alice", "p1", 4_000, "acct")]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await bal("alice")).toBe(6_000);
    expect(await ledgerSum("alice")).toBe(-4_000);
  });

  it("refuses to hold more than the balance", async () => {
    await expect(holdFunds("alice", "p2", 10_001, "acct")).rejects.toThrow(/Insufficient/);
    expect(await bal("alice")).toBe(10_000);
  });

  it("returns funds exactly once when a payout fails", async () => {
    await holdFunds("alice", "p3", 2_500, "acct");
    await Promise.all([failPayout("p3", "bank said no"), failPayout("p3", "bank said no")]);
    expect(await bal("alice")).toBe(10_000);
    expect(await ledgerSum("alice")).toBe(0);
    expect((await db.doc("payouts/p3").get()).data()!.status).toBe("failed");
  });

  it("cannot fail a payout that was already paid", async () => {
    await holdFunds("alice", "p4", 1_000, "acct");
    await markPaid("p4");
    await failPayout("p4", "late failure");
    expect(await bal("alice")).toBe(9_000);
    expect((await db.doc("system/totals").get()).data()!.paidOutCents).toBe(1_000);
  });

  it("enforces daily limits on payouts", async () => {
    await holdFunds("alice", "p_dl1", 4_000, "acct", 5_000);
    expect(await bal("alice")).toBe(6_000);

    await expect(holdFunds("alice", "p_dl2", 2_000, "acct", 5_000)).rejects.toThrow(/Daily limit/);
    expect(await bal("alice")).toBe(6_000);

    await holdFunds("alice", "p_dl3", 1_000, "acct", 5_000);
    expect(await bal("alice")).toBe(5_000);
  });
});

describe("recurring schedules", () => {
  beforeEach(() => reset({ alice: 10_000, bob: 0 }));

  const schedule = (o: Record<string, unknown> = {}) => db.doc("schedules/s1").set({
    ownerUid: "alice", ownerEmail: "alice@x.com", toUid: "bob", toEmail: "bob@x.com", amountCents: 1_500,
    note: "", frequency: "monthly", anchorDay: 31, nextRunAt: Timestamp.fromMillis(Date.now() - 1000),
    runCount: 0, failures: 0, status: "active", ...o,
  });

  it("pays a due run exactly once under concurrent ticks and advances past now", async () => {
    await schedule();
    const results = await Promise.all([runSchedule("s1"), runSchedule("s1"), runSchedule("s1")]);
    expect(results.filter((r) => r === "paid")).toHaveLength(1);
    expect(await bal("bob")).toBe(1_500);
    const s = (await db.doc("schedules/s1").get()).data()!;
    expect(s.runCount).toBe(1);
    expect((s.nextRunAt as Timestamp).toMillis()).toBeGreaterThan(Date.now());
  });

  it("makes one catch-up payment after long downtime, not one per missed period", async () => {
    await schedule({ frequency: "weekly", nextRunAt: Timestamp.fromMillis(Date.now() - 60 * 864e5) });
    await runSchedule("s1");
    await runSchedule("s1");
    expect(await bal("bob")).toBe(1_500);
  });

  it("auto-pauses after 3 failures and never overdraws", async () => {
    await schedule({ amountCents: 20_000 });
    for (let i = 0; i < 4; i++) await runSchedule("s1");
    const s = (await db.doc("schedules/s1").get()).data()!;
    expect(s.status).toBe("paused");
    expect(s.failures).toBe(3);
    expect(await bal("alice")).toBe(10_000);
  });

  it("does not run for a frozen owner", async () => {
    await db.doc("users/alice").update({ frozen: true });
    await schedule();
    expect(await runSchedule("s1")).toBe("failed");
    expect(await bal("bob")).toBe(0);
  });

  it("keeps the anchor day across short months", () => {
    const jan31 = new Date(Date.UTC(2026, 0, 31));
    const feb = nextRun(jan31, "monthly", 31);
    expect(feb.toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(nextRun(feb, "monthly", 31).toISOString().slice(0, 10)).toBe("2026-03-31");
  });
});

describe("reversals and stats", () => {
  beforeEach(() => reset({ alice: 10_000, bob: 0 }));

  it("reversal returns funds with refund entries and bypasses the daily limit", async () => {
    const { txId } = await executeTransfer(db, input({ amountCents: 3_000 }));
    await executeTransfer(db, input({ fromUid: "bob", toUid: "alice", amountCents: 3_000,
      idempotencyKey: `rev_${txId}`, perDayLimit: 0, reversalOf: txId }));
    expect(await bal("alice")).toBe(10_000);
    expect(await bal("bob")).toBe(0);
    const refunds = (await db.collection("ledger").where("type", "==", "refund").get()).size;
    expect(refunds).toBe(2);
  });

  it("reversal is refused if the recipient already spent the funds", async () => {
    const { txId } = await executeTransfer(db, input({ amountCents: 3_000 }));
    await db.doc("wallets/bob").update({ balanceCents: 1_000 });
    await expect(executeTransfer(db, input({ fromUid: "bob", toUid: "alice", amountCents: 3_000,
      idempotencyKey: `rev_${txId}`, reversalOf: txId }))).rejects.toThrow(/Insufficient/);
  });

  it("monthly stats track in/out and payout refunds net out", async () => {
    await executeTransfer(db, input({ amountCents: 2_000 }));
    await holdFunds("alice", "p9", 1_000, "acct");
    await failPayout("p9", "nope");
    const m = monthKey();
    const a = (await db.doc(`stats/alice_${m}`).get()).data()!;
    const b = (await db.doc(`stats/bob_${m}`).get()).data()!;
    expect(a.outCents).toBe(2_000);
    expect(b.inCents).toBe(2_000);
  });
});
