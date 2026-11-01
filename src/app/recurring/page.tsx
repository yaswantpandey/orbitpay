"use client";

import { useState, useSyncExternalStore } from "react";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KycBanner } from "@/components/kyc-banner";
import { functions } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { useSchedules } from "@/lib/hooks";
import { createScheduleSchema, dollarsToCents } from "@/lib/schemas";
import type { Schedule } from "@/types";

const DEV = process.env.NEXT_PUBLIC_USE_EMULATORS === "true";

export default function RecurringPage() {
  const schedules = useSchedules().filter((s) => s.status !== "cancelled");
  const [toEmail, setToEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("monthly");
  const [startDate, setStartDate] = useState("");
  const today = useSyncExternalStore(
    () => () => {},
    () => new Date().toISOString().slice(0, 10),
    () => ""
  );
  const [busy, setBusy] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = dollarsToCents(amount);
    if (amountCents === null) return toast.error("Enter a valid amount, e.g. 12.50");
    const parsed = createScheduleSchema.safeParse({ toEmail: toEmail.trim(), amountCents, note, frequency, startDate });
    if (!parsed.success) return toast.error(parsed.error.issues[0].message);
    setBusy("create");
    try {
      await httpsCallable(functions, "createSchedule")(parsed.data);
      toast.success(`${frequency === "weekly" ? "Weekly" : "Monthly"} payment to ${parsed.data.toEmail} scheduled`);
      setToEmail(""); setAmount(""); setNote(""); setStartDate("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function act(s: Schedule, action: "pause" | "resume" | "cancel") {
    if (action === "cancel" && !confirm(`Cancel recurring payment to ${s.toEmail}?`)) return;
    setBusy(s.id);
    try {
      await httpsCallable(functions, "scheduleAction")({ scheduleId: s.id, action });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    try {
      const { data } = await httpsCallable<unknown, { paid: number; failed: number }>(functions, "devRunSchedules")({});
      toast.success(`Ran due schedules: ${data.paid} paid, ${data.failed} failed`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <KycBanner />
      <Card>
        <CardHeader>
          <CardTitle>New recurring payment</CardTitle>
          <CardDescription>Runs automatically from your wallet. Pauses itself after 3 failed attempts.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="to">Pay (email)</Label>
              <Input id="to" type="email" required value={toEmail} onChange={(e) => setToEmail(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="amount">Amount (USD)</Label>
              <Input id="amount" inputMode="decimal" placeholder="0.00" required value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="freq">Every</Label>
              <select id="freq" value={frequency} onChange={(e) => setFrequency(e.target.value as "weekly" | "monthly")}
                className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
                <option value="weekly">Week</option>
                <option value="monthly">Month</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="start">First payment</Label>
              <Input id="start" type="date" min={today} required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="note">Note (optional)</Label>
              <Input id="note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button type="submit" className="sm:col-span-2" disabled={busy === "create"}>Schedule</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Scheduled</CardTitle>
          {DEV && <Button size="sm" variant="outline" onClick={runNow}>Run due now (dev only)</Button>}
        </CardHeader>
        <CardContent>
          {schedules.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No recurring payments.</p>
          ) : (
            <ul className="divide-y">
              {schedules.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">{formatCents(s.amountCents)}</span>
                      <span className="text-sm text-muted-foreground">/ {s.frequency === "weekly" ? "week" : "month"}</span>
                      <Badge variant={s.status === "active" ? "default" : "outline"}>{s.status}</Badge>
                    </div>
                    <p className="truncate text-sm text-muted-foreground">to {s.toEmail}{s.note ? ` — ${s.note}` : ""}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.status === "active" ? `Next: ${s.nextRunAt?.toDate().toLocaleDateString()}` : "Paused"}
                      {` · ${s.runCount} paid`}
                      {s.lastError ? ` · last error: ${s.lastError}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {s.status === "active" ? (
                      <Button size="sm" variant="outline" disabled={busy === s.id} onClick={() => act(s, "pause")}>Pause</Button>
                    ) : (
                      <Button size="sm" disabled={busy === s.id} onClick={() => act(s, "resume")}>Resume</Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => act(s, "cancel")}>Cancel</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
