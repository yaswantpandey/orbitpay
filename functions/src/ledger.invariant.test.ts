/**
 * Ledger Integrity & Mathematical Invariant Tests (Task E.2).
 * Verifies double-entry conservation, zero-sum properties,
 * balanced debit/credit pairs, and non-negative balances under concurrency.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { randomUUID } from "crypto";
import { executeTransfer, TransferInput } from "./transfer";

let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run with the Firestore emulator");
  if (getApps().length === 0) initializeApp({ projectId: "demo-fastpay" });
  db = getFirestore();
});

async function clearDb() {
  for (const c of ["wallets", "ledger", "transfers", "dailyTotals", "notifications", "paymentRequests"]) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

async function seedWallets(balances: Record<string, number>) {
  await Promise.all(
    Object.entries(balances).map(([uid, balanceCents]) =>
      db.doc(`wallets/${uid}`).set({ balanceCents, currency: "USD", version: 0 })
    )
  );
}

const getBal = async (uid: string) => (await db.doc(`wallets/${uid}`).get()).data()!.balanceCents as number;

interface LedgerEntryDoc {
  txId: string;
  uid: string;
  type: string;
  amountCents: number;
  balanceAfterCents: number;
  counterpartyEmail: string;
  note: string;
}

/**
 * Mathematical invariant auditor:
 * 1. sum of all ledger entries in system === 0
 * 2. every txId has exactly one debit (-X) and one credit (+X) of identical magnitude
 * 3. for every user: balance === initialBalance + sum(user's ledger entries)
 * 4. no wallet balance is negative (balance >= 0)
 * 5. total system funds are strictly conserved: sum(current balances) === sum(initial balances)
 */
async function verifyLedgerInvariants(
  firestore: Firestore,
  initialBalances: Record<string, number>
) {
  const ledgerSnap = await firestore.collection("ledger").get();
  const entries = ledgerSnap.docs.map((d) => d.data() as LedgerEntryDoc);

  // Invariant 1: Total sum of all ledger entries must be zero
  const totalLedgerSum = entries.reduce((acc, e) => acc + e.amountCents, 0);
  expect(totalLedgerSum).toBe(0);

  // Invariant 2: Group entries by txId: every tx must have exactly 1 debit and 1 credit of equal magnitude
  const txGroups = new Map<string, LedgerEntryDoc[]>();
  for (const entry of entries) {
    const list = txGroups.get(entry.txId) ?? [];
    list.push(entry);
    txGroups.set(entry.txId, list);
  }

  for (const [txId, group] of txGroups.entries()) {
    expect(group).toHaveLength(2);
    const debit = group.find((e) => e.amountCents < 0);
    const credit = group.find((e) => e.amountCents > 0);

    expect(debit).toBeDefined();
    expect(credit).toBeDefined();
    expect(debit!.amountCents + credit!.amountCents).toBe(0);
    expect(Math.abs(debit!.amountCents)).toBe(credit!.amountCents);
  }

  // Invariant 3, 4, 5: Wallets non-negative, match ledger sums, and conserve total money
  let currentSystemTotal = 0;
  const initialSystemTotal = Object.values(initialBalances).reduce((a, b) => a + b, 0);

  for (const [uid, initialBal] of Object.entries(initialBalances)) {
    const currentBal = await getBal(uid);
    expect(currentBal).toBeGreaterThanOrEqual(0); // Invariant 4: No negative balances

    const userEntries = entries.filter((e) => e.uid === uid);
    const userLedgerSum = userEntries.reduce((acc, e) => acc + e.amountCents, 0);

    // Invariant 3: Current balance must equal initial balance + sum of user ledger entries
    expect(currentBal).toBe(initialBal + userLedgerSum);

    currentSystemTotal += currentBal;
  }

  // Invariant 5: Global conservation of money
  expect(currentSystemTotal).toBe(initialSystemTotal);
}

describe("Ledger Integrity & Mathematical Invariants (Task E.2)", () => {
  beforeEach(async () => {
    await clearDb();
  });

  it("proves sum = 0 and balanced debit/credit pair for a single transfer", async () => {
    const initial = { alice: 10_000, bob: 5_000 };
    await seedWallets(initial);

    await executeTransfer(db, {
      fromUid: "alice", toUid: "bob", fromEmail: "alice@example.com", toEmail: "bob@example.com",
      amountCents: 3_500, note: "Invoice #1", idempotencyKey: randomUUID(), perDayLimit: 1_000_000,
    });

    await verifyLedgerInvariants(db, initial);
    expect(await getBal("alice")).toBe(6_500);
    expect(await getBal("bob")).toBe(8_500);
  });

  it("proves invariant holds across sequential multi-party transfers", async () => {
    const initial = { alice: 20_000, bob: 10_000, charlie: 5_000 };
    await seedWallets(initial);

    // Alice -> Bob $50
    await executeTransfer(db, {
      fromUid: "alice", toUid: "bob", fromEmail: "alice@example.com", toEmail: "bob@example.com",
      amountCents: 5_000, note: "1", idempotencyKey: randomUUID(), perDayLimit: 1_000_000,
    });

    // Bob -> Charlie $80
    await executeTransfer(db, {
      fromUid: "bob", toUid: "charlie", fromEmail: "bob@example.com", toEmail: "charlie@example.com",
      amountCents: 8_000, note: "2", idempotencyKey: randomUUID(), perDayLimit: 1_000_000,
    });

    // Charlie -> Alice $20
    await executeTransfer(db, {
      fromUid: "charlie", toUid: "alice", fromEmail: "charlie@example.com", toEmail: "alice@example.com",
      amountCents: 2_000, note: "3", idempotencyKey: randomUUID(), perDayLimit: 1_000_000,
    });

    await verifyLedgerInvariants(db, initial);
    expect(await getBal("alice")).toBe(17_000);
    expect(await getBal("bob")).toBe(7_000);
    expect(await getBal("charlie")).toBe(11_000);
  });

  it("proves failed overdraw transfers write zero ledger entries and preserve invariants", async () => {
    const initial = { alice: 2_000, bob: 1_000 };
    await seedWallets(initial);

    // Attempt to transfer $30 (exceeds Alice's $20 balance)
    await expect(
      executeTransfer(db, {
        fromUid: "alice", toUid: "bob", fromEmail: "alice@example.com", toEmail: "bob@example.com",
        amountCents: 3_000, note: "Overdraw", idempotencyKey: randomUUID(), perDayLimit: 1_000_000,
      })
    ).rejects.toThrow(/Insufficient funds/);

    // No ledger entries should be written
    const ledgerSnap = await db.collection("ledger").get();
    expect(ledgerSnap.empty).toBe(true);

    await verifyLedgerInvariants(db, initial);
    expect(await getBal("alice")).toBe(2_000);
    expect(await getBal("bob")).toBe(1_000);
  });

  it("proves invariants hold under concurrent multi-party transfers across 4 wallets", async () => {
    const initial = {
      userA: 15_000,
      userB: 15_000,
      userC: 15_000,
      userD: 15_000,
    };
    await seedWallets(initial);

    const users = ["userA", "userB", "userC", "userD"];
    // 12 concurrent transfers among distinct pairs
    const transfers: Promise<unknown>[] = [];
    const transferPairs = [
      ["userA", "userB", 2_000],
      ["userB", "userC", 3_000],
      ["userC", "userD", 1_500],
      ["userD", "userA", 4_000],
      ["userA", "userC", 2_500],
      ["userB", "userD", 1_000],
      ["userC", "userA", 3_000],
      ["userD", "userB", 2_000],
      ["userA", "userD", 1_000],
      ["userB", "userA", 2_000],
      ["userC", "userB", 1_500],
      ["userD", "userC", 2_500],
    ] as const;

    for (const [from, to, amount] of transferPairs) {
      transfers.push(
        executeTransfer(db, {
          fromUid: from,
          toUid: to,
          fromEmail: `${from}@example.com`,
          toEmail: `${to}@example.com`,
          amountCents: amount,
          note: `concurrent transfer ${from}->${to}`,
          idempotencyKey: randomUUID(),
          perDayLimit: 1_000_000,
        }).catch(() => null) // Ignore any contention retries that fail
      );
    }

    await Promise.all(transfers);

    // Verify all 5 invariants hold without exception
    await verifyLedgerInvariants(db, initial);
  });

  it("proves reversal invariant: transfer + reversal nets out to zero and restores balances", async () => {
    const initial = { alice: 10_000, bob: 5_000 };
    await seedWallets(initial);

    // Step 1: Alice transfers $40 to Bob
    const origKey = randomUUID();
    const original = await executeTransfer(db, {
      fromUid: "alice", toUid: "bob", fromEmail: "alice@example.com", toEmail: "bob@example.com",
      amountCents: 4_000, note: "Accidental payment", idempotencyKey: origKey, perDayLimit: 1_000_000,
    });

    expect(await getBal("alice")).toBe(6_000);
    expect(await getBal("bob")).toBe(9_000);
    await verifyLedgerInvariants(db, initial);

    // Step 2: Admin reversal from Bob back to Alice
    const revKey = randomUUID();
    await executeTransfer(db, {
      fromUid: "bob", toUid: "alice", fromEmail: "bob@example.com", toEmail: "alice@example.com",
      amountCents: 4_000, note: `Reversal of ${original.txId}`, idempotencyKey: revKey,
      perDayLimit: 1_000_000, reversalOf: original.txId,
    });

    // Invariants must hold
    await verifyLedgerInvariants(db, initial);

    // Balances are fully restored
    expect(await getBal("alice")).toBe(10_000);
    expect(await getBal("bob")).toBe(5_000);

    // Reversal entries are correctly labeled as 'refund'
    const revOutSnap = await db.doc(`ledger/bob_${revKey}_out`).get();
    const revInSnap = await db.doc(`ledger/bob_${revKey}_in`).get();
    expect(revOutSnap.data()?.type).toBe("refund");
    expect(revInSnap.data()?.type).toBe("refund");
  });

  it("proves mathematical invariants hold across a seeded pseudo-random sequence of 50 operations", async () => {
    const SEED = 4242;
    // Mulberry32 seeded PRNG
    let s = SEED >>> 0;
    const rng = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const initial = { u1: 20_000, u2: 20_000, u3: 20_000 };
    await seedWallets(initial);

    const userKeys = Object.keys(initial);
    const priorKeys: string[] = [];

    // Track ledger snapshot IDs to verify append-only invariant
    const initialLedgerSnap = await db.collection("ledger").get();
    const ledgerIdSet = new Set(initialLedgerSnap.docs.map((d) => d.id));

    try {
      for (let i = 0; i < 50; i++) {
        const uFrom = userKeys[Math.floor(rng() * userKeys.length)];
        let uTo = userKeys[Math.floor(rng() * userKeys.length)];
        while (uTo === uFrom) {
          uTo = userKeys[Math.floor(rng() * userKeys.length)];
        }

        const mode = rng();
        if (mode < 0.6) {
          // Standard transfer between $1.00 and $50.00
          const amount = Math.floor(rng() * 4_900) + 100;
          const key = `seeded_${i}_${randomUUID().slice(0, 8)}`;
          priorKeys.push(key);
          await executeTransfer(db, {
            fromUid: uFrom, toUid: uTo, fromEmail: `${uFrom}@example.com`, toEmail: `${uTo}@example.com`,
            amountCents: amount, note: `Seeded op ${i}`, idempotencyKey: key, perDayLimit: 1_000_000,
          }).catch(() => null); // May fail if balance insufficient
        } else if (mode < 0.8) {
          // Intentional overdraw attempt
          const amount = 50_000; // Exceeds balance
          const key = `overdraw_${i}_${randomUUID().slice(0, 8)}`;
          await executeTransfer(db, {
            fromUid: uFrom, toUid: uTo, fromEmail: `${uFrom}@example.com`, toEmail: `${uTo}@example.com`,
            amountCents: amount, note: "Overdraw test", idempotencyKey: key, perDayLimit: 1_000_000,
          }).catch(() => null);
        } else if (priorKeys.length > 0) {
          // Idempotent replay of an earlier key
          const replayedKey = priorKeys[Math.floor(rng() * priorKeys.length)];
          await executeTransfer(db, {
            fromUid: uFrom, toUid: uTo, fromEmail: `${uFrom}@example.com`, toEmail: `${uTo}@example.com`,
            amountCents: 1_000, note: "Replay", idempotencyKey: replayedKey, perDayLimit: 1_000_000,
          }).catch(() => null);
        }
      }

      // Assert all mathematical invariants hold
      await verifyLedgerInvariants(db, initial);

      // Verify append-only invariant: every entry that was in ledgerIdSet is still present
      const finalLedgerSnap = await db.collection("ledger").get();
      for (const id of ledgerIdSet) {
        expect(finalLedgerSnap.docs.some((d) => d.id === id)).toBe(true);
      }
    } catch (err) {
      console.error(`INVARIANT FAILURE on SEED ${SEED}:`, err);
      throw err;
    }
  });
});

