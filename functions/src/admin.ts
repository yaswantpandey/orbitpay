import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { adminUserActionSchema, adminReverseSchema, adminSearchSchema } from "./schemas";
import { parse, requireAdmin, audit, CALLABLE_OPTIONS } from "./middleware";
import { executeTransfer } from "./transfer";

/** Look up users by email prefix (or the most recent 25), with wallet balances. */
export const adminSearchUsers = onCall(CALLABLE_OPTIONS, async (req) => {
  requireAdmin(req);
  const email = (parse(adminSearchSchema, req.data).email ?? "").trim().toLowerCase();
  const db = getFirestore();
  const q = email
    ? db.collection("users").where("email", ">=", email).where("email", "<=", email + "\uf8ff").limit(25)
    : db.collection("users").orderBy("createdAt", "desc").limit(25);
  const users = (await q.get()).docs;
  const wallets = users.length ? await db.getAll(...users.map((u) => db.doc(`wallets/${u.id}`))) : [];
  return {
    users: users.map((u, i) => {
      const d = u.data();
      return {
        uid: u.id, email: d.email, displayName: d.displayName ?? "", kycStatus: d.kycStatus, tier: d.tier ?? 0,
        frozen: !!d.frozen, balanceCents: wallets[i]?.data()?.balanceCents ?? 0,
        createdAt: d.createdAt?.toMillis?.() ?? null,
      };
    }),
  };
});

export const adminUserAction = onCall(CALLABLE_OPTIONS, async (req) => {
  const adminUid = requireAdmin(req);
  const { uid, action, reason } = parse(adminUserActionSchema, req.data);
  if (uid === adminUid) throw new HttpsError("invalid-argument", "You can't freeze your own account");
  const ref = getFirestore().doc(`users/${uid}`);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "User not found");
  await ref.update(action === "freeze"
    ? { frozen: true, frozenReason: reason, frozenAt: FieldValue.serverTimestamp() }
    : { frozen: false, frozenReason: FieldValue.delete(), frozenAt: FieldValue.delete() });
  // Force re-auth so an active session can't keep acting on stale state.
  if (action === "freeze") await getAuth().revokeRefreshTokens(uid);
  await audit(adminUid, `admin.${action}`, { targetUid: uid, reason }, req.rawRequest.ip ?? "");
  return { frozen: action === "freeze" };
});

/**
 * Reverse a completed P2P transfer with a compensating transfer (recipient -> sender).
 * Refuses if the recipient no longer has the funds; never drives a balance negative.
 */
export const adminReverseTransfer = onCall(CALLABLE_OPTIONS, async (req) => {
  const adminUid = requireAdmin(req);
  const { txId, reason } = parse(adminReverseSchema, req.data);
  const db = getFirestore();
  const ref = db.doc(`transfers/${txId}`);
  const t = (await ref.get()).data();
  if (!t) throw new HttpsError("not-found", "Transfer not found");
  if (t.reversalOf) throw new HttpsError("failed-precondition", "Can't reverse a reversal");
  if (t.reversedBy) throw new HttpsError("failed-precondition", "Already reversed");

  const [from, to] = await db.getAll(db.doc(`users/${t.fromUid}`), db.doc(`users/${t.toUid}`));
  const result = await executeTransfer(
    db,
    {
      fromUid: t.toUid, toUid: t.fromUid, fromEmail: to.data()?.email ?? "", toEmail: from.data()?.email ?? "",
      amountCents: t.amountCents, note: `Reversal: ${reason}`.slice(0, 200),
      idempotencyKey: `rev_${txId}`, perDayLimit: 0, reversalOf: txId,
    },
    {
      ref,
      check: (cur) => {
        if (cur?.reversedBy) throw new HttpsError("failed-precondition", "Already reversed");
      },
      update: { reversedBy: `${t.toUid}_rev_${txId}`, reversedAt: FieldValue.serverTimestamp(), reversalReason: reason },
      stampPayment: false,
    }
  );
  if (!result.replayed) {
    await audit(adminUid, "admin.reverse", { txId, reversalTxId: result.txId, amountCents: t.amountCents, reason },
      req.rawRequest.ip ?? "");
  }
  return { reversalTxId: result.txId };
});

export const adminAuditLog = onCall(CALLABLE_OPTIONS, async (req) => {
  requireAdmin(req);
  const uid = typeof req.data?.uid === "string" ? req.data.uid.slice(0, 128) : "";
  const db = getFirestore();
  const q = uid
    ? db.collection("auditLogs").where("actorUid", "==", uid).orderBy("createdAt", "desc").limit(100)
    : db.collection("auditLogs").orderBy("createdAt", "desc").limit(100);
  return {
    entries: (await q.get()).docs.map((d) => {
      const e = d.data();
      return { id: d.id, actorUid: e.actorUid, action: e.action, metadata: e.metadata, ip: e.ip ?? "",
        createdAt: e.createdAt?.toMillis?.() ?? null };
    }),
  };
});

/** Recent transfers for one user, so an admin can pick one to reverse. */
export const adminUserTransfers = onCall(CALLABLE_OPTIONS, async (req) => {
  requireAdmin(req);
  const uid = typeof req.data?.uid === "string" ? req.data.uid.slice(0, 128) : "";
  if (!uid) throw new HttpsError("invalid-argument", "uid required");
  const snap = await getFirestore().collection("transfers").where("participants", "array-contains", uid)
    .orderBy("createdAt", "desc").limit(50).get();
  return {
    transfers: snap.docs.map((d) => {
      const t = d.data();
      return { txId: d.id, fromUid: t.fromUid, toUid: t.toUid, amountCents: t.amountCents, note: t.note,
        reversalOf: t.reversalOf ?? null, reversedBy: t.reversedBy ?? null, createdAt: t.createdAt?.toMillis?.() ?? null };
    }),
  };
});
