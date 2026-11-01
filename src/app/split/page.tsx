"use client";

import { useMemo, useState } from "react";
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
import { usePaymentRequests, useSplits } from "@/lib/hooks";
import { dollarsToCents } from "@/lib/schemas";

type Person = { email: string; amount: string };

/** Even split in integer cents; the first people absorb the remainder cents. */
function evenShares(totalCents: number, people: number, includeMe: boolean) {
  const n = people + (includeMe ? 1 : 0);
  const base = Math.floor(totalCents / n);
  const extra = totalCents - base * n;
  // When I'm included, I take my base share and the others take the remainder cents.
  return Array.from({ length: people }, (_, i) => base + (i < extra ? 1 : 0));
}

export default function SplitPage() {
  const splits = useSplits();
  const requests = usePaymentRequests();
  const [title, setTitle] = useState("");
  const [total, setTotal] = useState("");
  const [includeMe, setIncludeMe] = useState(true);
  const [mode, setMode] = useState<"even" | "custom">("even");
  const [people, setPeople] = useState<Person[]>([{ email: "", amount: "" }]);
  const [busy, setBusy] = useState(false);

  const totalCents = dollarsToCents(total);
  const shares = useMemo(() => {
    if (mode === "custom") return people.map((p) => dollarsToCents(p.amount));
    return totalCents ? evenShares(totalCents, people.length, includeMe) : people.map(() => null);
  }, [mode, people, totalCents, includeMe]);
  const requested = shares.reduce<number>((s, c) => s + (c ?? 0), 0);
  const myShare = totalCents !== null ? totalCents - requested : null;

  const setPerson = (i: number, patch: Partial<Person>) =>
    setPeople((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return toast.error("Give the split a name");
    if (!totalCents) return toast.error("Enter a valid total, e.g. 84.00");
    if (shares.some((s) => !s)) return toast.error("Every person needs an amount of at least $0.01");
    if (myShare !== null && myShare < 0) return toast.error("Shares add up to more than the total");
    setBusy(true);
    try {
      await httpsCallable(functions, "createSplit")({
        title: title.trim(), totalCents,
        shares: people.map((p, i) => ({ email: p.email.trim(), amountCents: shares[i]! })),
      });
      toast.success(`Requested ${formatCents(requested)} from ${people.length} ${people.length === 1 ? "person" : "people"}`);
      setTitle(""); setTotal(""); setPeople([{ email: "", amount: "" }]);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>Split a bill</CardTitle>
          <CardDescription>Each person gets a payment request for their share. Everyone needs an OrbitPay account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="title">What for</Label>
                <Input id="title" maxLength={100} placeholder="Dinner at Luca's" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="total">Total (USD)</Label>
                <Input id="total" inputMode="decimal" placeholder="0.00" value={total} onChange={(e) => setTotal(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === "even"} onChange={() => setMode("even")} /> Split evenly
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} /> Custom amounts
              </label>
              {mode === "even" && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={includeMe} onChange={(e) => setIncludeMe(e.target.checked)} /> Include me
                </label>
              )}
            </div>

            <div className="space-y-2">
              <Label>People</Label>
              {people.map((p, i) => (
                <div key={i} className="grid grid-cols-[1fr_7rem_auto] gap-2">
                  <Input type="email" placeholder="friend@example.com" value={p.email} onChange={(e) => setPerson(i, { email: e.target.value })} />
                  {mode === "custom" ? (
                    <Input inputMode="decimal" placeholder="0.00" value={p.amount} onChange={(e) => setPerson(i, { amount: e.target.value })} />
                  ) : (
                    <div className="flex items-center justify-end text-sm tabular-nums">{shares[i] ? formatCents(shares[i]!) : "—"}</div>
                  )}
                  <Button type="button" variant="ghost" size="icon" aria-label="Remove person" disabled={people.length === 1}
                    onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" disabled={people.length >= 20}
                onClick={() => setPeople((ps) => [...ps, { email: "", amount: "" }])}>
                <Plus className="size-4" /> Add person
              </Button>
            </div>

            <div className="flex items-center justify-between border-t pt-4 text-sm">
              <span className="text-muted-foreground">
                Requesting <b className="text-foreground">{formatCents(requested)}</b>
                {myShare !== null && <> · your share <b className={myShare < 0 ? "text-red-600" : "text-foreground"}>{formatCents(myShare)}</b></>}
              </span>
              <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send requests"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>My splits</CardTitle></CardHeader>
        <CardContent>
          {splits.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No splits yet.</p>
          ) : (
            <ul className="divide-y">
              {splits.map((s) => {
                const reqs = requests.filter((r) => s.requestIds.includes(r.id));
                const paid = reqs.filter((r) => r.status === "paid");
                const collected = paid.reduce((t, r) => t + r.amountCents, 0);
                return (
                  <li key={s.id} className="space-y-2 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">{s.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatCents(collected)} of {formatCents(s.totalCents - s.ownShareCents)} collected · {paid.length}/{s.shares.length} paid
                        </p>
                      </div>
                      <span className="font-semibold tabular-nums">{formatCents(s.totalCents)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full bg-green-600" style={{ width: `${(collected / Math.max(1, s.totalCents - s.ownShareCents)) * 100}%` }} />
                    </div>
                    <ul className="flex flex-wrap gap-1.5">
                      {s.shares.map((sh) => {
                        const r = reqs.find((x) => x.payerEmail === sh.email);
                        return (
                          <li key={sh.email}>
                            <Badge variant={r?.status === "paid" ? "secondary" : "outline"}>
                              {sh.email} · {formatCents(sh.amountCents)} · {r?.status ?? "…"}
                            </Badge>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
