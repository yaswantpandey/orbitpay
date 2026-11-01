"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection, getDocs, limit, orderBy, query, startAfter, where,
  QueryConstraint, QueryDocumentSnapshot, Timestamp,
} from "firebase/firestore";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TransactionList } from "@/components/transaction-list";
import { useAuth } from "@/components/auth-provider";
import { useLedgerTags } from "@/lib/hooks";
import { db } from "@/lib/firebase";
import type { LedgerEntry } from "@/types";

const PAGE = 20;
const TYPES = [
  { value: "all", label: "All" },
  { value: "topup", label: "Added money" },
  { value: "transfer_out", label: "Sent" },
  { value: "transfer_in", label: "Received" },
  { value: "payout", label: "Withdrawals" },
  { value: "refund", label: "Refunds" },
];

export default function HistoryPage() {
  const { user } = useAuth();
  const tags = useLedgerTags();
  const [type, setType] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (after: QueryDocumentSnapshot | null) => {
    if (!user) return;
    setLoading(true);
    const c: QueryConstraint[] = [where("uid", "==", user.uid)];
    if (type !== "all") c.push(where("type", "==", type));
    if (from) c.push(where("createdAt", ">=", Timestamp.fromDate(new Date(from))));
    if (to) c.push(where("createdAt", "<", Timestamp.fromDate(new Date(new Date(to).getTime() + 86_400_000))));
    c.push(orderBy("createdAt", "desc"), limit(PAGE));
    if (after) c.push(startAfter(after));
    const snap = await getDocs(query(collection(db, "ledger"), ...c));
    const page = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as LedgerEntry);
    setEntries((prev) => (after ? [...prev, ...page] : page));
    setCursor(snap.docs.at(-1) ?? null);
    setHasMore(snap.docs.length === PAGE);
    setLoading(false);
  }, [user, type, from, to]);

  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (active) load(null);
    })();
    return () => { active = false; };
  }, [load]);

  const s = search.trim().toLowerCase();
  const visible = s
    ? entries.filter((e) => `${e.counterpartyEmail ?? ""} ${e.note ?? ""} ${e.txId}`.toLowerCase().includes(s))
    : entries;
  const taggedVisible = useMemo(
    () => visible.map((e) => ({ ...e, category: tags[e.id] ?? e.category })),
    [visible, tags]
  );

  function exportCsv() {
    const esc = (v: string) => {
      // Neutralize CSV formula injection (OWASP / CWE-1236)
      const sanitized = /^[\s]*[=+\-@\t\r]/.test(v) ? `'${v}` : v;
      return `"${sanitized.replace(/"/g, '""')}"`;
    };
    const rows = [
      ["date", "type", "amount_usd", "balance_after_usd", "counterparty", "note", "tx_id"],
      ...visible.map((e) => [
        e.createdAt?.toDate().toISOString() ?? "",
        e.type,
        (e.amountCents / 100).toFixed(2),
        (e.balanceAfterCents / 100).toFixed(2),
        e.counterpartyEmail ?? "",
        e.note ?? "",
        e.txId,
      ]),
    ];
    const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `orbitpay-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Transaction history</CardTitle>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={visible.length === 0}>
          <Download /> Export CSV
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="type">Type</Label>
            <select id="type" value={type} onChange={(e) => setType(e.target.value)}
              className="h-8 w-full rounded-lg border bg-background px-2 text-sm">
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="from">From</Label>
            <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="to">To</Label>
            <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="search">Search</Label>
            <Input id="search" placeholder="Email or note" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <TransactionList entries={taggedVisible} categorize
          onCategorized={(id, category) => setEntries((es) => es.map((x) => (x.id === id ? { ...x, category } : x)))} />
        {hasMore && (
          <Button variant="outline" className="w-full" onClick={() => load(cursor)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
