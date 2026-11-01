"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { addDoc, collection, deleteDoc, doc, serverTimestamp } from "firebase/firestore";
import QRCode from "qrcode";
import { Copy, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/components/auth-provider";
import { db } from "@/lib/firebase";
import { useContacts, useLedger } from "@/lib/hooks";
import { contactSchema, dollarsToCents } from "@/lib/schemas";

export default function ContactsPage() {
  const { user } = useAuth();
  const contacts = useContacts();
  const ledger = useLedger(100);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [qrAmount, setQrAmount] = useState("");
  const [qr, setQr] = useState<{ url: string; img: string } | null>(null);

  // People you've recently paid or been paid by, minus saved contacts.
  const recent = useMemo(() => {
    const saved = new Set(contacts.map((c) => c.email));
    const seen = new Set<string>();
    return ledger.map((e) => e.counterpartyEmail).filter((e): e is string => {
      if (!e || saved.has(e) || seen.has(e)) return false;
      seen.add(e);
      return true;
    }).slice(0, 10);
  }, [ledger, contacts]);

  useEffect(() => {
    if (!user?.email) return;
    const cents = qrAmount ? dollarsToCents(qrAmount) : null;
    const params = new URLSearchParams({ to: user.email });
    if (cents) params.set("amount", (cents / 100).toFixed(2));
    const url = `${window.location.origin}/pay?${params}`;
    QRCode.toDataURL(url, { width: 240, margin: 1 }).then((img) => setQr({ url, img })).catch(() => setQr(null));
  }, [user, qrAmount]);

  async function save(e: React.SyntheticEvent, preset?: string) {
    e.preventDefault();
    if (!user) return;
    const parsed = contactSchema.safeParse({ email: (preset ?? email).trim().toLowerCase(), name: preset ? "" : name.trim() });
    if (!parsed.success) return toast.error(parsed.error.issues[0].message);
    if (parsed.data.email === user.email?.toLowerCase()) return toast.error("That's you");
    if (contacts.some((c) => c.email === parsed.data.email)) return toast.error("Already saved");
    try {
      await addDoc(collection(db, "users", user.uid, "contacts"), { ...parsed.data, name: parsed.data.name ?? "", createdAt: serverTimestamp() });
      setEmail(""); setName("");
      toast.success("Contact saved");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const remove = (id: string) => user && deleteDoc(doc(db, "users", user.uid, "contacts", id)).catch((e) => toast.error(e.message));
  const sendHref = (to: string) => `/send?to=${encodeURIComponent(to)}`;

  return (
    <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-[3fr_2fr]">
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle>Add contact</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={save} className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="name">Name</Label>
                <Input id="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button type="submit">Save</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Saved contacts</CardTitle></CardHeader>
          <CardContent>
            {contacts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No saved contacts yet.</p>
            ) : (
              <ul className="divide-y">
                {contacts.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.name || c.email}</p>
                      {c.name && <p className="truncate text-sm text-muted-foreground">{c.email}</p>}
                    </div>
                    <div className="flex gap-1">
                      <Link href={sendHref(c.email)} className={buttonVariants({ size: "sm" })}><Send className="size-4" /> Pay</Link>
                      <Button size="sm" variant="ghost" aria-label="Delete contact" onClick={() => remove(c.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {recent.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Recent</CardTitle></CardHeader>
            <CardContent>
              <ul className="divide-y">
                {recent.map((r) => (
                  <li key={r} className="flex items-center justify-between gap-3 py-2">
                    <span className="truncate">{r}</span>
                    <div className="flex gap-1">
                      <Link href={sendHref(r)} className={buttonVariants({ size: "sm", variant: "outline" })}>Pay</Link>
                      <Button size="sm" variant="ghost" onClick={(e) => save(e, r)}>Save</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>My pay code</CardTitle>
          <CardDescription>Anyone with OrbitPay can scan this to pay you.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr.img} alt="QR code for your pay link" className="mx-auto size-60 rounded-lg border bg-white p-2" />
          ) : (
            <div className="mx-auto size-60 animate-pulse rounded-lg bg-muted" />
          )}
          <div className="space-y-1">
            <Label htmlFor="qramount">Fixed amount (optional)</Label>
            <Input id="qramount" inputMode="decimal" placeholder="0.00" value={qrAmount} onChange={(e) => setQrAmount(e.target.value)} />
          </div>
          <Button variant="outline" className="w-full" disabled={!qr}
            onClick={() => qr && navigator.clipboard.writeText(qr.url).then(() => toast.success("Link copied"))}>
            <Copy className="size-4" /> Copy pay link
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
