import { createHash, createHmac, randomBytes } from "crypto";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import {
  merchantProfileSchema, createCheckoutSchema, checkoutIdSchema, apiKeyActionSchema,
} from "./schemas";
import { parse, requireAuth, requireMoneyMover, audit, IS_EMULATOR } from "./middleware";
import { executeTransfer } from "./transfer";

const APP_URL = process.env.APP_URL ?? "http://localhost:3001";
const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 5;
// Retry delays after each failed webhook attempt; delivery is abandoned after the last one.
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host === "instance-data"
  ) {
    return true;
  }

  if (
    host === "::1" ||
    host === "::" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc00:") ||
    host.startsWith("fd00:")
  ) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b, c, d] = ipv4.map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

export function checkWebhookUrl(url: string) {
  if (!url) return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpsError("invalid-argument", "Invalid webhook URL format");
  }

  const isLocalOrPrivate = isPrivateOrReservedHost(u.hostname);
  if (IS_EMULATOR && (isLocalOrPrivate || u.protocol === "http:")) {
    return;
  }

  if (u.protocol !== "https:" || isLocalOrPrivate) {
    throw new HttpsError("invalid-argument", "Webhook URL must be a public https:// URL");
  }
}

// ---------- Merchant profile & API keys (callable, signed-in owner) ----------

export const setMerchantProfile = onCall(async (req) => {
  const input = parse(merchantProfileSchema, req.data);
  const { uid, user } = await requireMoneyMover(req);
  checkWebhookUrl(input.webhookUrl);
  const db = getFirestore();
  const ref = db.doc(`merchants/${uid}`);
  const secretRef = db.doc(`merchantSecrets/${uid}`);
  const [existingMerchant, existingSecretDoc] = await Promise.all([ref.get(), secretRef.get()]);
  const existing = existingMerchant.data();
  const existingSecret = existingSecretDoc.data()?.webhookSecret ?? existing?.webhookSecret;

  let newSecret: string | null = null;
  if (!existingSecret) {
    newSecret = `whsec_${randomBytes(24).toString("base64url")}`;
    await secretRef.set({
      uid,
      webhookSecret: newSecret,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  await ref.set({
    uid, email: user.email, businessName: input.businessName.trim(), webhookUrl: input.webhookUrl,
    enabled: true, updatedAt: FieldValue.serverTimestamp(),
    ...(existing ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });
  await audit(uid, existing ? "merchant.updated" : "merchant.enabled", { businessName: input.businessName });
  return { ok: true, ...(newSecret ? { webhookSecret: newSecret } : {}) };
});

export const rotateWebhookSecret = onCall(async (req) => {
  const uid = requireAuth(req);
  const db = getFirestore();
  const merchantSnap = await db.doc(`merchants/${uid}`).get();
  if (!merchantSnap.exists) throw new HttpsError("failed-precondition", "Set up your merchant profile first");
  const newSecret = `whsec_${randomBytes(24).toString("base64url")}`;
  await db.doc(`merchantSecrets/${uid}`).set({
    uid,
    webhookSecret: newSecret,
    rotatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await audit(uid, "merchant.secret_rotated", {});
  return { ok: true, webhookSecret: newSecret };
});

/** Returns the plaintext key exactly once; only its SHA-256 is stored. */
export const createApiKey = onCall(async (req) => {
  const uid = requireAuth(req);
  const db = getFirestore();
  if (!(await db.doc(`merchants/${uid}`).get()).exists) throw new HttpsError("failed-precondition", "Set up your merchant profile first");
  const active = await db.collection("apiKeys").where("uid", "==", uid).where("revoked", "==", false).count().get();
  if (active.data().count >= MAX_KEYS) throw new HttpsError("resource-exhausted", `Up to ${MAX_KEYS} active keys`);
  const key = `fp_${IS_EMULATOR ? "test" : "live"}_${randomBytes(24).toString("base64url")}`;
  const hash = sha256(key);
  await db.doc(`apiKeys/${hash}`).set({ uid, prefix: key.slice(0, 12), revoked: false, createdAt: FieldValue.serverTimestamp() });
  await audit(uid, "merchant.key_created", { keyId: hash.slice(0, 12) });
  return { key, keyId: hash, prefix: key.slice(0, 12) };
});

export const revokeApiKey = onCall(async (req) => {
  const uid = requireAuth(req);
  const { keyId } = parse(apiKeyActionSchema, req.data);
  const ref = getFirestore().doc(`apiKeys/${keyId}`);
  const k = (await ref.get()).data();
  if (!k || k.uid !== uid) throw new HttpsError("not-found", "Key not found");
  await ref.update({ revoked: true, revokedAt: FieldValue.serverTimestamp() });
  await audit(uid, "merchant.key_revoked", { keyId: keyId.slice(0, 12) });
  return { ok: true };
});

// ---------- Checkouts ----------

type CheckoutInput = { amountCents: number; description: string; reference?: string; successUrl?: string };

export async function createCheckoutDoc(merchantUid: string, input: CheckoutInput, idempotencyKey?: string) {
  const db = getFirestore();
  const merchant = (await db.doc(`merchants/${merchantUid}`).get()).data();
  if (!merchant?.enabled) throw new HttpsError("failed-precondition", "Merchant profile not enabled");
  const ref = idempotencyKey
    ? db.doc(`checkouts/co_${sha256(`${merchantUid}:${idempotencyKey}`).slice(0, 24)}`)
    : db.collection("checkouts").doc();
  const existing = await ref.get();
  if (existing.exists) return serializeCheckout(ref.id, existing.data()!);
  const data = {
    merchantUid, businessName: merchant.businessName, merchantEmail: merchant.email,
    amountCents: input.amountCents, currency: "USD", description: input.description,
    reference: input.reference ?? "", successUrl: input.successUrl ?? null, status: "open",
    expiresAt: Timestamp.fromMillis(Date.now() + CHECKOUT_TTL_MS), createdAt: Timestamp.now(),
  };
  await ref.create(data).catch(async (e) => { if (e.code !== 6) throw e; }); // concurrent identical key
  return serializeCheckout(ref.id, (await ref.get()).data()!);
}

function serializeCheckout(id: string, c: FirebaseFirestore.DocumentData) {
  const expired = c.status === "open" && (c.expiresAt as Timestamp).toMillis() < Date.now();
  return {
    id, object: "checkout", status: expired ? "expired" : c.status, amount: c.amountCents, currency: "usd",
    description: c.description, reference: c.reference, url: `${APP_URL}/checkout?id=${id}`,
    success_url: c.successUrl, expires_at: (c.expiresAt as Timestamp).toMillis(),
    created_at: (c.createdAt as Timestamp)?.toMillis?.() ?? null, paid_at: (c.paidAt as Timestamp)?.toMillis?.() ?? null,
  };
}

/** Merchant creates a checkout from the dashboard (same as the API, but authenticated by session). */
export const createCheckout = onCall(async (req) => {
  const input = parse(createCheckoutSchema, req.data);
  const uid = requireAuth(req);
  return createCheckoutDoc(uid, input);
});

/** Public view of a checkout for the hosted payment page (signed-in payers). */
export const getCheckout = onCall(async (req) => {
  requireAuth(req);
  const { checkoutId } = parse(checkoutIdSchema, req.data);
  const c = (await getFirestore().doc(`checkouts/${checkoutId}`).get()).data();
  if (!c) throw new HttpsError("not-found", "Checkout not found");
  const s = serializeCheckout(checkoutId, c);
  return { id: s.id, status: s.status, amountCents: c.amountCents, description: c.description,
    businessName: c.businessName, successUrl: c.successUrl, expiresAt: s.expires_at };
});

export const payCheckout = onCall(async (req) => {
  const { checkoutId } = parse(checkoutIdSchema, req.data);
  const { uid, user, limits } = await requireMoneyMover(req);
  const db = getFirestore();
  const ref = db.doc(`checkouts/${checkoutId}`);
  const c = (await ref.get()).data();
  if (!c) throw new HttpsError("not-found", "Checkout not found");
  if (c.merchantUid === uid) throw new HttpsError("invalid-argument", "You can't pay your own checkout");
  if (c.amountCents > limits.perTransaction) throw new HttpsError("resource-exhausted", "Amount exceeds per-transaction limit");

  const result = await executeTransfer(
    db,
    {
      fromUid: uid, toUid: c.merchantUid, fromEmail: user.email, toEmail: c.merchantEmail,
      amountCents: c.amountCents, note: `${c.businessName}: ${c.description}`.slice(0, 200),
      // Same payer retrying replays this key; a different payer is stopped by the status check below.
      idempotencyKey: `checkout_${checkoutId}`, perDayLimit: limits.perDay,
    },
    {
      ref,
      check: (cur) => {
        if (cur?.status !== "open") throw new HttpsError("failed-precondition", `Checkout is ${cur?.status}`);
        if ((cur.expiresAt as Timestamp).toMillis() < Date.now()) throw new HttpsError("failed-precondition", "Checkout has expired");
      },
      update: { status: "paid", payerUid: uid, payerEmail: user.email },
    }
  );
  // Always (re)ensure the webhook is queued: covers a crash between payment and enqueue.
  await enqueueWebhook(c.merchantUid, `${checkoutId}_paid`, "checkout.paid", checkoutId);
  if (!result.replayed) await audit(uid, "checkout.paid", { checkoutId, merchantUid: c.merchantUid, amountCents: c.amountCents });
  return { status: "paid", txId: result.txId, successUrl: c.successUrl };
});

// ---------- Public REST API ----------

async function authenticateKey(header: string | undefined) {
  const key = header?.match(/^Bearer\s+(fp_(?:test|live)_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (!key) return null;
  const k = (await getFirestore().doc(`apiKeys/${sha256(key)}`).get()).data();
  if (!k || k.revoked) return null;
  const owner = (await getFirestore().doc(`users/${k.uid}`).get()).data();
  if (!owner || owner.frozen) return null;
  return k.uid as string;
}

/** POST /v1/checkouts, GET /v1/checkouts/:id. Authenticated with `Authorization: Bearer fp_..._...`. */
export const api = onRequest(async (req, res) => {
  const fail = (status: number, message: string) => res.status(status).json({ error: { message } });
  const merchantUid = await authenticateKey(req.headers.authorization);
  if (!merchantUid) return void fail(401, "Invalid or revoked API key");
  const path = req.path.replace(/\/+$/, "");
  try {
    if (req.method === "POST" && path === "/v1/checkouts") {
      const parsed = createCheckoutSchema.safeParse(req.body);
      if (!parsed.success) return void fail(400, parsed.error.issues[0]?.message ?? "Invalid body");
      const idem = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].slice(0, 200) : undefined;
      return void res.status(201).json(await createCheckoutDoc(merchantUid, parsed.data, idem));
    }
    const m = path.match(/^\/v1\/checkouts\/([A-Za-z0-9_-]{1,200})$/);
    if (req.method === "GET" && m) {
      const c = (await getFirestore().doc(`checkouts/${m[1]}`).get()).data();
      // Same 404 for "missing" and "someone else's" so ids can't be probed.
      if (!c || c.merchantUid !== merchantUid) return void fail(404, "Checkout not found");
      return void res.json(serializeCheckout(m[1], c));
    }
    return void fail(404, "Not found");
  } catch (e) {
    if (e instanceof HttpsError) return void fail(e.httpErrorCode.status, e.message);
    logger.error("api error", e);
    return void fail(500, "Internal error");
  }
});

// ---------- Webhooks ----------

export async function enqueueWebhook(merchantUid: string, id: string, type: string, checkoutId: string) {
  const merchant = (await getFirestore().doc(`merchants/${merchantUid}`).get()).data();
  if (!merchant?.webhookUrl) return;
  await getFirestore().doc(`webhookDeliveries/${id}`).create({
    merchantUid, type, checkoutId, url: merchant.webhookUrl, status: "pending", attempts: 0,
    nextAttemptAt: Timestamp.now(), createdAt: FieldValue.serverTimestamp(),
  }).catch((e) => { if (e.code !== 6) throw e; });
}

/** Signature header: `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>` (Stripe-style). */
export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

export async function attemptDelivery(id: string) {
  const db = getFirestore();
  const ref = db.doc(`webhookDeliveries/${id}`);
  // Claim the attempt so overlapping schedulers don't double-send.
  const d = await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data();
    if (!cur || cur.status !== "pending" || (cur.nextAttemptAt as Timestamp).toMillis() > Date.now()) return null;
    tx.update(ref, { nextAttemptAt: Timestamp.fromMillis(Date.now() + 120_000) }); // lease
    return cur;
  });
  if (!d) return "skipped";
  const [merchant, secretDoc, checkout] = await Promise.all([
    db.doc(`merchants/${d.merchantUid}`).get(),
    db.doc(`merchantSecrets/${d.merchantUid}`).get(),
    db.doc(`checkouts/${d.checkoutId}`).get(),
  ]);
  const secret = secretDoc.data()?.webhookSecret ?? merchant.data()?.webhookSecret ?? "";
  const body = JSON.stringify({ id, type: d.type, created: Math.floor(Date.now() / 1000),
    data: serializeCheckout(d.checkoutId, checkout.data()!) });
  let ok = false, status = 0, error = "";
  try {
    const r = await fetch(d.url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "orbitpay-signature": signPayload(secret, body),
        "fastpay-signature": signPayload(secret, body),
      },
      body,
    });
    status = r.status;
    ok = r.status >= 200 && r.status < 300;
  } catch (e) {
    error = (e as Error).message;
  }
  const attempts = (d.attempts as number) + 1;
  await ref.update(ok
    ? { status: "delivered", attempts, lastStatus: status, deliveredAt: FieldValue.serverTimestamp() }
    : attempts > BACKOFF_MS.length
      ? { status: "failed", attempts, lastStatus: status, lastError: error }
      : { attempts, lastStatus: status, lastError: error, nextAttemptAt: Timestamp.fromMillis(Date.now() + BACKOFF_MS[attempts - 1]) });
  return ok ? "delivered" : "failed";
}

export const deliverWebhookOnCreate = onDocumentCreated("webhookDeliveries/{id}", async (e) => {
  await attemptDelivery(e.params.id);
});

export async function retryDueWebhooks() {
  const due = await getFirestore().collection("webhookDeliveries")
    .where("status", "==", "pending").where("nextAttemptAt", "<=", Timestamp.now()).limit(100).get();
  const out = { delivered: 0, failed: 0, skipped: 0 };
  for (const d of due.docs) out[await attemptDelivery(d.id)]++;
  return out;
}

export const retryWebhooksTick = onSchedule("every 5 minutes", async () => {
  logger.info("retryWebhooksTick", await retryDueWebhooks());
});

/** DEV ONLY: retry pending deliveries now, ignoring backoff. */
export const devRetryWebhooks = onCall(async (req) => {
  if (!IS_EMULATOR) throw new HttpsError("permission-denied", "Not available");
  const uid = requireAuth(req);
  const pending = await getFirestore().collection("webhookDeliveries")
    .where("merchantUid", "==", uid).where("status", "==", "pending").get();
  await Promise.all(pending.docs.map((d) => d.ref.update({ nextAttemptAt: Timestamp.now() })));
  return retryDueWebhooks();
});
