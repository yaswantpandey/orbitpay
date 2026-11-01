"use client";

import { useState, useSyncExternalStore } from "react";
import { httpsCallable } from "firebase/functions";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KycBanner } from "@/components/kyc-banner";
import { functions } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { useInvoices } from "@/lib/hooks";
import { createInvoiceSchema, dollarsToCents } from "@/lib/schemas";
import type { Invoice } from "@/types";

type Line = { description: string; quantity: string; unitPrice: string };
type Action = "send" | "cancel" | "pay" | "pdf";

const emptyLine = (): Line => ({ description: "", quantity: "1", unitPrice: "" });

export default function InvoicesPage() {
  const { issued, received } = useInvoices();
  const [recipientEmail, setRecipientEmail] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [busy, setBusy] = useState<string | null>(null);
  const today = useSyncExternalStore(() => () => {}, () => new Date().toISOString().slice(0, 10), () => "");

  const cents = lines.map((l) => {
    const unit = dollarsToCents(l.unitPrice);
    const qty = /^\d+$/.test(l.quantity) ? parseInt(l.quantity, 10) : NaN;
    return unit === null || Number.isNaN(qty) ? null : { qty, unit };
  });
  const total = cents.reduce((s, c) => s + (c ? c.qty * c.unit : 0), 0);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function create(send: boolean) {
    if (cents.some((c) => c === null)) return toast.error("Each line needs a whole quantity and a price like 12.50");
    const parsed = createInvoiceSchema.safeParse({
      recipientEmail: recipientEmail.trim(),
      dueDate,
      memo,
      send,
      lineItems: lines.map((l, i) => ({
        description: l.description.trim(), quantity: cents[i]!.qty, unitPriceCents: cents[i]!.unit,
      })),
    });
    if (!parsed.success) return toast.error(parsed.error.issues[0].message);
    setBusy("create");
    try {
      const { data } = await httpsCallable<unknown, { number: string }>(functions, "createInvoice")(parsed.data);
      toast.success(`${data.number} ${send ? "sent" : "saved as draft"}`);
      setRecipientEmail(""); setDueDate(""); setMemo(""); setLines([emptyLine()]);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function act(inv: Invoice, action: Action) {
    if (action === "pay" && !confirm(`Pay ${formatCents(inv.totalCents)} to ${inv.issuerEmail}?`)) return;
    if (action === "cancel" && !confirm(`Cancel ${inv.number}?`)) return;
    setBusy(inv.id);
    try {
      const { data } = await httpsCallable<unknown, { filename?: string; base64?: string }>(
        functions, "invoiceAction")({ invoiceId: inv.id, action });
      if (action === "pdf" && data.base64) {
        const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        const a = Object.assign(document.createElement("a"), { href: url, download: data.filename });
        a.click();
        URL.revokeObjectURL(url);
      } else {
        toast.success({ send: "Invoice sent", cancel: "Invoice cancelled", pay: "Invoice paid", pdf: "" }[action]);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>New invoice</CardTitle>
          <CardDescription>The recipient pays from their OrbitPay wallet using the same email.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="to">Bill to (email)</Label>
              <Input id="to" type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="due">Due date</Label>
              <Input id="due" type="date" value={dueDate} min={today}
                onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Line items</Label>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_4rem_6rem_auto] gap-2">
                <Input placeholder="Description" maxLength={200} value={l.description}
                  onChange={(e) => setLine(i, { description: e.target.value })} />
                <Input aria-label="Quantity" inputMode="numeric" value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })} />
                <Input aria-label="Unit price" inputMode="decimal" placeholder="0.00" value={l.unitPrice}
                  onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                <Button variant="ghost" size="icon" disabled={lines.length === 1} aria-label="Remove line"
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" disabled={lines.length >= 50}
              onClick={() => setLines((ls) => [...ls, emptyLine()])}>
              <Plus className="size-4" /> Add line
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="memo">Memo (optional)</Label>
            <Input id="memo" maxLength={500} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <span className="text-lg font-semibold tabular-nums">Total {formatCents(total)}</span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy === "create"} onClick={() => create(false)}>Save draft</Button>
              <Button disabled={busy === "create"} onClick={() => create(true)}>Send invoice</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <InvoiceList title="Invoices to pay" items={received} who={(i) => `from ${i.issuerName || i.issuerEmail}`}
        busy={busy} actions={(i) => ["sent", "overdue"].includes(i.status) ? ["pay"] : []} onAction={act} />
      <InvoiceList title="Invoices I sent" items={issued} who={(i) => `to ${i.recipientEmail}`} busy={busy}
        actions={(i) => i.status === "draft" ? ["send", "cancel"] : ["sent", "overdue"].includes(i.status) ? ["cancel"] : []}
        onAction={act} />
    </div>
  );
}

const ACTION_LABELS: Record<Action, string> = { send: "Send", cancel: "Cancel", pay: "Pay", pdf: "PDF" };

function InvoiceList({ title, items, who, busy, actions, onAction }: {
  title: string;
  items: Invoice[];
  who: (i: Invoice) => string;
  busy: string | null;
  actions: (i: Invoice) => Action[];
  onAction: (i: Invoice, a: Action) => void;
}) {
  const now = useSyncExternalStore(
    () => () => {},
    () => Date.now(),
    () => 0
  );
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y">
            {items.map((inv) => {
              const overdue = inv.status === "sent" && !!now && inv.dueDate?.toMillis() < now;
              const status = overdue ? "overdue" : inv.status;
              return (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{inv.number}</span>
                      <Badge variant={status === "overdue" ? "destructive" : status === "paid" ? "secondary" : "outline"}>
                        {status}
                      </Badge>
                    </div>
                    <p className="truncate text-sm text-muted-foreground">{who(inv)}</p>
                    <p className="text-xs text-muted-foreground">Due {inv.dueDate?.toDate().toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold tabular-nums">{formatCents(inv.totalCents)}</span>
                    {[...actions(inv), "pdf" as const].map((a) => (
                      <Button key={a} size="sm" variant={a === "pay" || a === "send" ? "default" : "outline"}
                        disabled={busy === inv.id} onClick={() => onAction(inv, a)}>
                        {ACTION_LABELS[a]}
                      </Button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
