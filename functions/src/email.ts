import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { IS_EMULATOR } from "./middleware";

export const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const FROM = process.env.EMAIL_FROM ?? "OrbitPay <notifications@orbitpay.example>";
const APP_URL = process.env.APP_URL ?? "http://localhost:3001";
const DEV_EMAIL = IS_EMULATOR;

export interface Mail { to: string; subject: string; text: string; link?: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const stripCrlf = (s: string) => s.replace(/[\r\n\t]/g, " ").trim();
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

/**
 * Queue an email. The doc id is the idempotency key: retried transactions/triggers
 * overwrite the same doc instead of sending twice. Works inside a transaction or batch.
 */
export function queueMail(
  w: FirebaseFirestore.Transaction | FirebaseFirestore.WriteBatch, id: string, mail: Mail
) {
  (w as FirebaseFirestore.WriteBatch).set(getFirestore().doc(`mailOutbox/${id}`), {
    ...mail, subject: stripCrlf(mail.subject), status: "queued", createdAt: FieldValue.serverTimestamp(),
  });
}

/** In-app notification → email, unless the user opted out. */
export const emailOnNotification = onDocumentCreated("notifications/{id}", async (event) => {
  const n = event.data?.data();
  if (!n) return;
  const db = getFirestore();
  const user = (await db.doc(`users/${n.uid}`).get()).data();
  if (!user?.email || user.emailNotifications === false) return;
  const mail = renderNotification(n);
  if (!mail) return;
  // create() fails if this notification was already emailed (trigger redelivery).
  await db.doc(`mailOutbox/notif_${event.params.id}`)
    .create({ ...mail, subject: stripCrlf(mail.subject), to: user.email, status: "queued", createdAt: FieldValue.serverTimestamp() })
    .catch((e) => { if (e.code !== 6) throw e; }); // 6 = ALREADY_EXISTS
});

function renderNotification(n: FirebaseFirestore.DocumentData): Omit<Mail, "to"> | null {
  const amt = usd(n.amountCents ?? 0);
  const note = n.note ? ` — "${n.note}"` : "";
  switch (n.kind) {
    case "transfer_in": return { subject: `You received ${amt}`, text: `${n.fromEmail} sent you ${amt}${note}.`, link: "/history" };
    case "request": return { subject: `${n.fromEmail} requested ${amt}`, text: `${n.fromEmail} requested ${amt}${note}.`, link: "/requests" };
    case "invoice": return { subject: `New invoice for ${amt}`, text: `${n.fromEmail} sent you an invoice for ${amt}.`, link: "/invoices" };
    case "schedule_failed": return { subject: "A recurring payment failed", text: `Your ${amt} payment to ${n.fromEmail} failed: ${n.note}`, link: "/recurring" };
    case "kyc": return { subject: "Identity verification update", text: n.note, link: "/settings" };
    case "hold": return { subject: "A payment is being reviewed", text: n.note, link: "/history" };
    default: return null;
  }
}

/** Sends queued mail. Retries come from the trigger's own retry; status records the outcome. */
export const deliverMail = onDocumentCreated(
  { document: "mailOutbox/{id}", secrets: DEV_EMAIL ? [] : [RESEND_API_KEY] },
  async (event) => {
    const m = event.data?.data() as (Mail & { status: string }) | undefined;
    if (!m || m.status !== "queued") return;
    const ref = event.data!.ref;
    const html = `<p>${esc(m.text)}</p>` +
      (m.link ? `<p><a href="${esc(APP_URL + m.link)}">Open OrbitPay</a></p>` : "") +
      `<p style="color:#888;font-size:12px">You can turn off email notifications in Settings.</p>`;
    if (DEV_EMAIL) {
      logger.info(`[dev email] to=${m.to} subject="${m.subject}"`, { text: m.text });
      await ref.update({ status: "logged", html, sentAt: FieldValue.serverTimestamp() });
      return;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY.value()}`, "content-type": "application/json",
        "idempotency-key": event.params.id },
      body: JSON.stringify({ from: FROM, to: [m.to], subject: m.subject, html, text: m.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await ref.update({ status: "failed", error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` });
      logger.error("Email send failed", { id: event.params.id, status: res.status });
      return;
    }
    await ref.update({ status: "sent", providerId: ((await res.json()) as { id?: string }).id ?? "", sentAt: FieldValue.serverTimestamp() });
  }
);
