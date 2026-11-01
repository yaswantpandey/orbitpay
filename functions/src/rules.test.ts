/**
 * Comprehensive Firestore Security Rules Unit Tests using @firebase/rules-unit-testing.
 * Verifies rule invariants against the Firestore emulator (npm run test:ledger).
 */
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import * as fs from "fs";
import * as path from "path";

let testEnv: RulesTestEnvironment;
const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp;

beforeAll(async () => {
  const hostAndPort = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  const [host, portStr] = hostAndPort.split(":");
  const rules = fs.readFileSync(path.resolve(__dirname, "../../firestore.rules"), "utf8");

  testEnv = await initializeTestEnvironment({
    projectId: "demo-fastpay",
    firestore: {
      host: host || "127.0.0.1",
      port: portStr ? parseInt(portStr, 10) : 8080,
      rules,
    },
  });
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

describe("Firestore Security Rules: users/{uid}", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("users/alice").set({
        email: "alice@example.com",
        displayCurrency: "USD",
        emailNotifications: true,
        contactCount: 0,
        kycStatus: "none",
        tier: 0,
      });
    });
  });

  it("allows owner to read their own profile", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(alice.doc("users/alice").get());
  });

  it("denies another user from reading profile", async () => {
    const bob = testEnv.authenticatedContext("bob").firestore();
    await assertFails(bob.doc("users/alice").get());
  });

  it("denies unauthenticated user from reading profile", async () => {
    const unauth = testEnv.unauthenticatedContext().firestore();
    await assertFails(unauth.doc("users/alice").get());
  });

  it("allows owner to update displayCurrency to whitelisted currencies", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    for (const c of ["USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD"]) {
      await assertSucceeds(alice.doc("users/alice").update({ displayCurrency: c }));
    }
  });

  it("denies owner from updating displayCurrency to non-whitelisted currency", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("users/alice").update({ displayCurrency: "XYZ" }));
    await assertFails(alice.doc("users/alice").update({ displayCurrency: "USDT" }));
    await assertFails(alice.doc("users/alice").update({ displayCurrency: "BTC" }));
  });

  it("allows owner to update emailNotifications", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(alice.doc("users/alice").update({ emailNotifications: false }));
  });

  it("denies owner from updating privileged fields like tier, kycStatus, or contactCount", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("users/alice").update({ tier: 2 }));
    await assertFails(alice.doc("users/alice").update({ kycStatus: "verified" }));
    await assertFails(alice.doc("users/alice").update({ contactCount: 5 }));
    await assertFails(alice.doc("users/alice").update({ email: "hacker@example.com" }));
  });

  it("denies owner from creating or deleting user document", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("users/alice").set({ displayCurrency: "USD" }));
    await assertFails(alice.doc("users/alice").delete());
  });
});

describe("Firestore Security Rules: contacts (users/{uid}/contacts/{contactId})", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("users/alice").set({
        contactCount: 0,
      });
      await ctx.firestore().doc("users/capped").set({
        contactCount: 100,
      });
      await ctx.firestore().doc("users/alice/contacts/c1").set({
        name: "Bob",
        email: "bob@example.com",
        createdAt: new Date(),
      });
    });
  });

  it("allows owner to create a contact with valid fields and server timestamp", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(
      alice.collection("users/alice/contacts").add({
        name: "Charlie",
        email: "charlie@example.com",
        createdAt: serverTimestamp(),
      })
    );
  });

  it("denies contact creation with spoofed/client-specified createdAt", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(
      alice.collection("users/alice/contacts").add({
        name: "Charlie",
        email: "charlie@example.com",
        createdAt: new Date("2020-01-01"),
      })
    );
  });

  it("denies contact creation with invalid email format", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(
      alice.collection("users/alice/contacts").add({
        name: "Bad Email",
        email: "not-an-email",
        createdAt: serverTimestamp(),
      })
    );
  });

  it("denies contact creation when contactCount >= 100", async () => {
    const capped = testEnv.authenticatedContext("capped").firestore();
    await assertFails(
      capped.collection("users/capped/contacts").add({
        name: "Over Limit",
        email: "over@example.com",
        createdAt: serverTimestamp(),
      })
    );
  });

  it("allows owner to update contact name", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(
      alice.doc("users/alice/contacts/c1").update({
        name: "Robert",
      })
    );
  });

  it("denies owner from updating contact email or createdAt", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(
      alice.doc("users/alice/contacts/c1").update({
        email: "newemail@example.com",
      })
    );
    await assertFails(
      alice.doc("users/alice/contacts/c1").update({
        createdAt: serverTimestamp(),
      })
    );
  });

  it("allows owner to delete contact", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(alice.doc("users/alice/contacts/c1").delete());
  });

  it("denies non-owner from accessing contacts", async () => {
    const bob = testEnv.authenticatedContext("bob").firestore();
    await assertFails(bob.doc("users/alice/contacts/c1").get());
    await assertFails(bob.doc("users/alice/contacts/c1").delete());
  });
});

describe("Firestore Security Rules: ledger & ledgerTags", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("ledger/entry1").set({
        uid: "alice",
        amountCents: -1500,
        type: "transfer_out",
        createdAt: new Date(),
      });
      await ctx.firestore().doc("ledgerTags/entry1").set({
        uid: "alice",
        category: "food",
        updatedAt: new Date(),
      });
    });
  });

  it("allows owner to read ledger entry, denies other user", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    const bob = testEnv.authenticatedContext("bob").firestore();
    await assertSucceeds(alice.doc("ledger/entry1").get());
    await assertFails(bob.doc("ledger/entry1").get());
  });

  it("denies ANY client write to /ledger/{entryId} (strictly immutable)", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("ledger/entry1").update({ category: "food" }));
    await assertFails(alice.doc("ledger/entry1").update({ note: "hacked" }));
    await assertFails(alice.doc("ledger/entry2").set({ uid: "alice", amountCents: 100 }));
    await assertFails(alice.doc("ledger/entry1").delete());
  });

  it("allows owner to read, create and update category in /ledgerTags/{entryId}", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(alice.doc("ledgerTags/entry1").get());

    for (const cat of ["food", "transport", "shopping", "bills", "entertainment", "rent", "travel", "health", "other", ""]) {
      await assertSucceeds(
        alice.doc("ledgerTags/entry1").set({
          uid: "alice",
          category: cat,
          updatedAt: serverTimestamp(),
        })
      );
    }
  });

  it("denies owner from setting non-whitelisted category in /ledgerTags/{entryId}", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(
      alice.doc("ledgerTags/entry1").set({
        uid: "alice",
        category: "gambling",
      })
    );
  });

  it("denies owner from setting extra keys or spoofing uid in /ledgerTags/{entryId}", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(
      alice.doc("ledgerTags/entry1").set({
        uid: "bob",
        category: "food",
      })
    );
    await assertFails(
      alice.doc("ledgerTags/entry1").set({
        uid: "alice",
        category: "food",
        amountCents: 9999,
      })
    );
  });

  it("denies non-owner from reading or writing /ledgerTags/{entryId}", async () => {
    const bob = testEnv.authenticatedContext("bob").firestore();
    await assertFails(bob.doc("ledgerTags/entry1").get());
    await assertFails(
      bob.doc("ledgerTags/entry1").set({
        uid: "bob",
        category: "food",
      })
    );
  });
});

describe("Firestore Security Rules: merchants & merchantSecrets", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("merchants/alice").set({
        uid: "alice",
        businessName: "Alice Store",
        webhookUrl: "https://example.com/webhook",
      });
      await ctx.firestore().doc("merchantSecrets/alice").set({
        uid: "alice",
        webhookSecret: "whsec_super_secret_key_123",
      });
    });
  });

  it("allows owner to read /merchants/{uid}", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(alice.doc("merchants/alice").get());
  });

  it("denies other user from reading /merchants/{uid}", async () => {
    const bob = testEnv.authenticatedContext("bob").firestore();
    await assertFails(bob.doc("merchants/alice").get());
  });

  it("denies client write to /merchants/{uid}", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("merchants/alice").update({ businessName: "Hacked" }));
  });

  it("STRICTLY DENIES client read and write to /merchantSecrets/{uid} (server-only)", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    const bob = testEnv.authenticatedContext("bob").firestore();
    const unauth = testEnv.unauthenticatedContext().firestore();

    // Owner cannot read their own signing secret from client
    await assertFails(alice.doc("merchantSecrets/alice").get());
    await assertFails(alice.doc("merchantSecrets/alice").set({ webhookSecret: "fake" }));

    // Other user cannot read or write
    await assertFails(bob.doc("merchantSecrets/alice").get());
    await assertFails(bob.doc("merchantSecrets/alice").set({ webhookSecret: "fake" }));

    // Unauthenticated cannot read or write
    await assertFails(unauth.doc("merchantSecrets/alice").get());
  });
});

describe("Firestore Security Rules: invoices and verified email", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("invoices/inv1").set({
        issuerUid: "alice",
        recipientEmail: "bob@example.com",
        amountCents: 5000,
        status: "issued",
      });
    });
  });

  it("allows issuer to read invoice", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertSucceeds(alice.doc("invoices/inv1").get());
  });

  it("allows recipient with verified email matching recipientEmail to read invoice", async () => {
    const bob = testEnv.authenticatedContext("bob", {
      email: "bob@example.com",
      email_verified: true,
    }).firestore();
    await assertSucceeds(bob.doc("invoices/inv1").get());
  });

  it("denies recipient with UNVERIFIED email from reading invoice", async () => {
    const bobUnverified = testEnv.authenticatedContext("bob", {
      email: "bob@example.com",
      email_verified: false,
    }).firestore();
    await assertFails(bobUnverified.doc("invoices/inv1").get());
  });

  it("denies another user with different email from reading invoice", async () => {
    const charlie = testEnv.authenticatedContext("charlie", {
      email: "charlie@example.com",
      email_verified: true,
    }).firestore();
    await assertFails(charlie.doc("invoices/inv1").get());
  });

  it("denies client write to invoices", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("invoices/inv1").update({ status: "paid" }));
  });
});

describe("Firestore Security Rules: fallback & server-only collections", () => {
  it("denies client access to internal auditLogs, dailyTotals, system, and unknown paths", async () => {
    const alice = testEnv.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("auditLogs/a1").get());
    await assertFails(alice.doc("dailyTotals/d1").get());
    await assertFails(alice.doc("system/config").get());
    await assertFails(alice.doc("unknownCollection/random").get());
    await assertFails(alice.doc("wallets/alice").set({ balanceCents: 100000 }));
  });
});

