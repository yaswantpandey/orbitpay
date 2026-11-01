"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/format";
import { useLedger, useMonthStats } from "@/lib/hooks";

const MONTHS = 6;

function lastMonths(n: number) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });

export default function InsightsPage() {
  const stats = useMonthStats(MONTHS);
  const ledger = useLedger(300);
  const monthKeys = useSyncExternalStore(() => () => {}, () => lastMonths(MONTHS), () => []);

  const months = useMemo(() => {
    const byMonth = new Map(stats.map((s) => [s.month, s]));
    return monthKeys.map((m) => ({ month: m, in: byMonth.get(m)?.inCents ?? 0, out: byMonth.get(m)?.outCents ?? 0 }));
  }, [stats, monthKeys]);
  const max = Math.max(1, ...months.flatMap((m) => [m.in, m.out]));
  const current = months.at(-1) ?? { month: "", in: 0, out: 0 };

  // Category + counterparty breakdowns come from this month's outgoing ledger entries.
  const { categories, people, spent } = useMemo(() => {
    const thisMonth = current.month;
    // Moves between your own balances (savings, conversions, holds under review) aren't spending.
    const internal = new Set(["fx_out", "savings_in", "hold"]);
    const out = ledger.filter((e) => e.amountCents < 0 && !internal.has(e.type)
      && e.createdAt?.toDate().toISOString().slice(0, 7) === thisMonth);
    const cat = new Map<string, number>();
    const ppl = new Map<string, number>();
    for (const e of out) {
      const amt = -e.amountCents;
      const c = e.category || (e.type === "payout" ? "withdrawals" : "uncategorised");
      cat.set(c, (cat.get(c) ?? 0) + amt);
      if (e.counterpartyEmail) ppl.set(e.counterpartyEmail, (ppl.get(e.counterpartyEmail) ?? 0) + amt);
    }
    const sort = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return { categories: sort(cat), people: sort(ppl).slice(0, 5), spent: out.reduce((s, e) => s - e.amountCents, 0) };
  }, [ledger, current.month]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Insights</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="In this month" value={formatCents(current.in)} tone="text-green-600" />
        <Stat label="Out this month" value={formatCents(current.out)} tone="text-red-600" />
        <Stat label="Net" value={`${current.in - current.out < 0 ? "−" : "+"}${formatCents(Math.abs(current.in - current.out))}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Money in vs out</CardTitle>
          <CardDescription>Last {MONTHS} months (USD)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex h-48 items-end gap-3" role="img" aria-label="Monthly money in and out">
            {months.map((m) => (
              <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-40 w-full items-end justify-center gap-1">
                  <div className="w-1/3 rounded-t bg-green-600" style={{ height: `${(m.in / max) * 100}%` }} title={`In ${formatCents(m.in)}`} />
                  <div className="w-1/3 rounded-t bg-red-500" style={{ height: `${(m.out / max) * 100}%` }} title={`Out ${formatCents(m.out)}`} />
                </div>
                <span className="text-xs text-muted-foreground">{monthLabel(m.month)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-green-600" /> In</span>
            <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-red-500" /> Out</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spending by category</CardTitle>
            <CardDescription>This month · tag transactions in History</CardDescription>
          </CardHeader>
          <CardContent>
            <Bars rows={categories} total={spent} empty="No spending this month." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top recipients</CardTitle>
            <CardDescription>This month</CardDescription>
          </CardHeader>
          <CardContent>
            <Bars rows={people} total={spent} empty="No payments this month." />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function Bars({ rows, total, empty }: { rows: [string, number][]; total: number; empty: string }) {
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-3">
      {rows.map(([label, cents]) => (
        <li key={label} className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="truncate capitalize">{label}</span>
            <span className="tabular-nums">{formatCents(cents)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${(cents / Math.max(1, total)) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
