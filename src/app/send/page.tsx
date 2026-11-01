"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { v4 as uuid } from "uuid";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KycBanner } from "@/components/kyc-banner";
import { functions } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { useContacts, useLedger, useWallet } from "@/lib/hooks";
import { dollarsToCents, transferSchema } from "@/lib/schemas";

type Draft = { toEmail: string; amountCents: number; note: string; idempotencyKey: string };

export default function SendPage() {
  const router = useRouter();
  const wallet = useWallet();
  const [toEmail, setToEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const contacts = useContacts();
  const ledger = useLedger(50);
  const suggestions = useMemo(() => {
    const m = new Map<string, string>();
    contacts.forEach((c) => m.set(c.email, c.name));
    ledger.forEach((e) => { if (e.counterpartyEmail && !m.has(e.counterpartyEmail)) m.set(e.counterpartyEmail, ""); });
    return [...m.entries()];
  }, [contacts, ledger]);

  // Prefill from a pay link or contact (/send?to=&amount=&note=).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const to = p.get("to");
    const amt = p.get("amount");
    const nt = p.get("note");
    if (!to && !amt && !nt) return;
    queueMicrotask(() => {
      if (to) setToEmail(to.slice(0, 200));
      if (amt && dollarsToCents(amt) !== null) setAmount(amt);
      if (nt) setNote(nt.slice(0, 200));
    });
  }, []);

  function review(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = dollarsToCents(amount);
    if (amountCents === null) return toast.error("Enter a valid amount, e.g. 12.50");
    // Key is generated once per reviewed transfer, so retries never double-send.
    const parsed = transferSchema.safeParse({ toEmail: toEmail.trim(), amountCents, note, idempotencyKey: uuid() });
    if (!parsed.success) return toast.error(parsed.error.issues[0].message);
    if (wallet && amountCents > wallet.balanceCents) return toast.error("Insufficient funds");
    setDraft(parsed.data);
  }

  async function confirm() {
    if (!draft) return;
    setBusy(true);
    try {
      const { data } = await httpsCallable<unknown, { status: string }>(functions, "transfer")(draft);
      if (data.status === "held") {
        toast.info("Your payment is being reviewed for your security. We'll notify you shortly.", { duration: 8000 });
      } else {
        toast.success(`Sent ${formatCents(draft.amountCents)} to ${draft.toEmail}`);
      }
      router.push("/history");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>{draft ? "Confirm transfer" : "Send money"}</CardTitle>
          <CardDescription>Available: {wallet ? formatCents(wallet.balanceCents) : "—"}</CardDescription>
        </CardHeader>
        <CardContent>
          {draft ? (
            <div className="space-y-4">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">To</dt><dd>{draft.toEmail}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Amount</dt>
                  <dd className="text-lg font-semibold">{formatCents(draft.amountCents)}</dd></div>
                {draft.note && <div className="flex justify-between"><dt className="text-muted-foreground">Note</dt><dd>{draft.note}</dd></div>}
                <div className="flex justify-between"><dt className="text-muted-foreground">Fee</dt><dd>$0.00</dd></div>
              </dl>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setDraft(null)} disabled={busy}>Back</Button>
                <Button className="flex-1" onClick={confirm} disabled={busy}>{busy ? "Sending…" : "Send now"}</Button>
              </div>
            </div>
          ) : (
            <form onSubmit={review} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="to">Recipient email</Label>
                <Input id="to" type="email" required list="contact-suggestions" autoComplete="off" value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)} />
                <datalist id="contact-suggestions">
                  {suggestions.map(([email, name]) => <option key={email} value={email}>{name}</option>)}
                </datalist>
              </div>
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (USD)</Label>
                <Input id="amount" inputMode="decimal" placeholder="0.00" required value={amount}
                  onChange={(e) => setAmount(e.target.value)} />
                <div className="flex gap-1.5 pt-1">
                  {["10", "25", "50", "100"].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAmount(preset)}
                      className="rounded-md border bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="note">Note (optional)</Label>
                <Input id="note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <Button type="submit" className="w-full">Review</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
