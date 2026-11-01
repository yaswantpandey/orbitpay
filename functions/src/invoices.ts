import { getFirestore, FieldValue, Timestamp, DocumentData } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createInvoiceSchema, invoiceActionSchema, invoiceTotal } from "./schemas";
import { parse, requireAuth, requireMoneyMover, audit, CALLABLE_OPTIONS } from "./middleware";
import { executeTransfer } from "./transfer";
import { queueMail } from "./email";

const usd = (c: number) => `$${(c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

export const createInvoice = onCall(CALLABLE_OPTIONS, async (req) => {
  const input = parse(createInvoiceSchema, req.data);
  const { uid, user } = await requireMoneyMover(req);
  const db = getFirestore();
  const recipientEmail = input.recipientEmail.toLowerCase();
  if (recipientEmail === user.email) throw new HttpsError("invalid-argument", "Cannot invoice yourself");

  const due = Timestamp.fromDate(new Date(`${input.dueDate}T23:59:59Z`));
  if (Number.isNaN(due.toMillis()) || due.toMillis() < Date.now()) {
    throw new HttpsError("invalid-argument", "Due date must be today or later");
  }
  const totalCents = invoiceTotal(input.lineItems);
  if (totalCents > 1_000_000) throw new HttpsError("invalid-argument", "Invoice total exceeds $10,000");

  const ref = db.collection("invoices").doc();
  const number = `INV-${new Date().getUTCFullYear()}-${ref.id.slice(0, 6).toUpperCase()}`;
  const batch = db.batch();
  batch.set(ref, {
    number,
    issuerUid: uid,
    issuerEmail: user.email,
    issuerName: user.displayName ?? "",
    recipientEmail,
    lineItems: input.lineItems,
    totalCents,
    memo: input.memo ?? "",
    dueDate: due,
    status: input.send ? "sent" : "draft",
    createdAt: FieldValue.serverTimestamp(),
    ...(input.send ? { sentAt: FieldValue.serverTimestamp() } : {}),
  });
  if (input.send) await notifyRecipient(batch, ref.id, recipientEmail, user.email, totalCents);
  await batch.commit();
  await audit(uid, "invoice.created", { invoiceId: ref.id, totalCents, sent: input.send });
  return { invoiceId: ref.id, number };
});

export const invoiceAction = onCall(CALLABLE_OPTIONS, async (req) => {
  const { invoiceId, action } = parse(invoiceActionSchema, req.data);
  const uid = requireAuth(req);
  const email = req.auth!.token.email_verified ? String(req.auth!.token.email ?? "").toLowerCase() : "";
  const db = getFirestore();
  const ref = db.doc(`invoices/${invoiceId}`);
  const inv = (await ref.get()).data();
  const isIssuer = inv?.issuerUid === uid;
  const isRecipient = !!email && inv?.recipientEmail === email;
  if (!inv || (!isIssuer && !isRecipient)) throw new HttpsError("not-found", "Invoice not found");

  if (action === "pdf") return { filename: `${inv.number}.pdf`, base64: await renderPdf(inv) };

  if (action === "send" || action === "cancel") {
    if (!isIssuer) throw new HttpsError("permission-denied", "Only the issuer can do that");
    const allowed = action === "send" ? ["draft"] : ["draft", "sent", "overdue"];
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()!;
      if (!allowed.includes(cur.status)) throw new HttpsError("failed-precondition", `Invoice is ${cur.status}`);
      if (action === "send") {
        tx.update(ref, { status: "sent", sentAt: FieldValue.serverTimestamp() });
        await notifyRecipient(tx, invoiceId, cur.recipientEmail, cur.issuerEmail, cur.totalCents);
      } else {
        tx.update(ref, { status: "cancelled", cancelledAt: FieldValue.serverTimestamp() });
      }
    });
    await audit(uid, `invoice.${action}`, { invoiceId });
    return { status: action === "send" ? "sent" : "cancelled" };
  }

  // pay
  if (!isRecipient) throw new HttpsError("permission-denied", "Only the recipient can pay");
  const { user, limits } = await requireMoneyMover(req);
  if (inv.totalCents > limits.perTransaction) {
    throw new HttpsError("resource-exhausted", "Amount exceeds per-transaction limit");
  }
  const result = await executeTransfer(
    db,
    {
      fromUid: uid,
      toUid: inv.issuerUid,
      fromEmail: user.email,
      toEmail: inv.issuerEmail,
      amountCents: inv.totalCents,
      note: `Invoice ${inv.number}`,
      idempotencyKey: `inv_${invoiceId}`,
      perDayLimit: limits.perDay,
    },
    {
      ref,
      check: (cur) => {
        if (cur?.recipientEmail !== email) throw new HttpsError("permission-denied", "Only the recipient can pay");
        if (!["sent", "overdue"].includes(cur.status)) {
          throw new HttpsError("failed-precondition", `Invoice is ${cur.status}`);
        }
      },
      update: { status: "paid", payerUid: uid },
    }
  );
  if (!result.replayed) await audit(uid, "invoice.paid", { invoiceId, txId: result.txId });
  return { status: "paid", txId: result.txId };
});

/** In-app notification if the recipient has an OrbitPay account; otherwise an email invite. */
async function notifyRecipient(
  w: FirebaseFirestore.WriteBatch | FirebaseFirestore.Transaction,
  invoiceId: string, recipientEmail: string, fromEmail: string, amountCents: number
) {
  const users = await getFirestore().collection("users").where("email", "==", recipientEmail).limit(1).get();
  if (users.empty) {
    queueMail(w, `invoice_${invoiceId}`, {
      to: recipientEmail,
      subject: `${fromEmail} sent you an invoice for ${usd(amountCents)}`,
      text: `${fromEmail} sent you an invoice for ${usd(amountCents)}. Sign up for OrbitPay with this email address to view and pay it.`,
      link: "/invoices",
    });
    return;
  }
  // Both WriteBatch and Transaction expose set(ref, data).
  (w as FirebaseFirestore.WriteBatch).set(getFirestore().doc(`notifications/${invoiceId}_inv`), {
    uid: users.docs[0].id, kind: "invoice", amountCents, fromEmail, note: "", read: false,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function renderPdf(inv: DocumentData): Promise<string> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.4, 0.4, 0.4);
  let y = 790;
  const sanitizePdf = (s: string) => String(s ?? "").replace(/[^\x20-\x7E\xA0-\xFF]/g, " ").trim();
  const text = (s: string, x: number, opts: { size?: number; f?: typeof font; color?: typeof grey } = {}) =>
    page.drawText(sanitizePdf(s), { x, y, size: opts.size ?? 10, font: opts.f ?? font, color: opts.color });

  text("OrbitPay", 50, { size: 20, f: bold });
  text(`INVOICE ${inv.number}`, 380, { size: 14, f: bold });
  y -= 20;
  text(`Status: ${String(inv.status).toUpperCase()}`, 380, { color: grey });
  y -= 30;
  text("From", 50, { f: bold }); text("Bill to", 300, { f: bold });
  y -= 14;
  text(inv.issuerName || inv.issuerEmail, 50); text(inv.recipientEmail, 300);
  y -= 14;
  text(inv.issuerEmail, 50, { color: grey });
  text(`Due ${(inv.dueDate as Timestamp).toDate().toISOString().slice(0, 10)}`, 300, { color: grey });

  y -= 40;
  text("Description", 50, { f: bold }); text("Qty", 330, { f: bold });
  text("Unit price", 390, { f: bold }); text("Amount", 480, { f: bold });
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: grey });
  for (const li of inv.lineItems as { description: string; quantity: number; unitPriceCents: number }[]) {
    y -= 18;
    text(li.description.slice(0, 50), 50);
    text(String(li.quantity), 330);
    text(usd(li.unitPriceCents), 390);
    text(usd(li.quantity * li.unitPriceCents), 480);
  }
  y -= 10;
  page.drawLine({ start: { x: 330, y }, end: { x: 545, y }, thickness: 0.5, color: grey });
  y -= 18;
  text("Total (USD)", 390, { f: bold }); text(usd(inv.totalCents), 480, { f: bold });
  if (inv.memo) { y -= 40; text(String(inv.memo).slice(0, 90), 50, { color: grey }); }

  return Buffer.from(await pdf.save()).toString("base64");
}
