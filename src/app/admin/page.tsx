"use client";

import { useCallback, useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { functions } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { useIsAdmin } from "@/lib/hooks";

type AdminUser = {
  uid: string; email: string; displayName: string; kycStatus: string; tier: number;
  frozen: boolean; balanceCents: number; createdAt: number | null;
};
type AuditEntry = { id: string; actorUid: string; action: string; metadata: Record<string, unknown>; ip: string; createdAt: number | null };
type AdminTransfer = {
  txId: string; fromUid: string; toUid: string; amountCents: number; note: string;
  reversalOf: string | null; reversedBy: string | null; createdAt: number | null;
};
type AdminHold = { holdId: string; fromEmail: string; toEmail: string; amountCents: number; note: string; reasons: string[]; createdAt: number | null };

const call = <T,>(name: string, data: unknown) => httpsCallable<unknown, T>(functions, name)(data).then((r) => r.data);
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "…");

export default function AdminPage() {
  const isAdmin = useIsAdmin();
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [transfers, setTransfers] = useState<AdminTransfer[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [holds, setHolds] = useState<AdminHold[]>([]);

  const loadHolds = useCallback(async () => {
    try {
      setHolds((await call<{ holds: AdminHold[] }>("adminListHolds", {})).holds);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  const loadUsers = useCallback(async (email: string) => {
    try {
      setUsers((await call<{ users: AdminUser[] }>("adminSearchUsers", { email })).users);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  const loadDetail = useCallback(async (u: AdminUser | null) => {
    try {
      const [a, t] = await Promise.all([
        call<{ entries: AuditEntry[] }>("adminAuditLog", u ? { uid: u.uid } : {}),
        u ? call<{ transfers: AdminTransfer[] }>("adminUserTransfers", { uid: u.uid }) : Promise.resolve({ transfers: [] }),
      ]);
      setAudit(a.entries);
      setTransfers(t.transfers);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      loadUsers("");
      loadDetail(null);
      loadHolds();
    })();
    return () => { active = false; };
  }, [isAdmin, loadUsers, loadDetail, loadHolds]);

  async function decide(h: AdminHold, decision: "approve" | "reject") {
    const reason = prompt(`${decision === "approve" ? "Approve" : "Reject"} ${formatCents(h.amountCents)} from ${h.fromEmail} to ${h.toEmail}. Reason (required):`);
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      await call("adminDecideHold", { holdId: h.holdId, decision, reason: reason.trim() });
      toast.success(decision === "approve" ? "Payment released" : "Payment rejected and refunded");
      await loadHolds();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setTier(u: AdminUser) {
    const tier = prompt(`Set tier for ${u.email} (0, 1 or 2). Current: ${u.tier}`);
    if (tier === null || !/^[012]$/.test(tier.trim())) return;
    const reason = prompt("Reason (required):");
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      await call("adminSetTier", { uid: u.uid, tier: Number(tier), reason: reason.trim() });
      const updated = { ...u, tier: Number(tier) };
      setUsers((us) => us.map((x) => (x.uid === u.uid ? updated : x)));
      setSelected(updated);
      toast.success(`Tier set to ${tier}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function select(u: AdminUser | null) {
    setSelected(u);
    await loadDetail(u);
  }

  async function toggleFreeze(u: AdminUser) {
    const reason = prompt(`${u.frozen ? "Unfreeze" : "Freeze"} ${u.email}. Reason (required):`);
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      await call("adminUserAction", { uid: u.uid, action: u.frozen ? "unfreeze" : "freeze", reason: reason.trim() });
      toast.success(`${u.email} ${u.frozen ? "unfrozen" : "frozen"}`);
      const updated = { ...u, frozen: !u.frozen };
      setUsers((us) => us.map((x) => (x.uid === u.uid ? updated : x)));
      await select(updated);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reverse(t: AdminTransfer) {
    const reason = prompt(`Reverse ${formatCents(t.amountCents)} (${t.txId})? Reason (required):`);
    if (!reason?.trim()) return;
    setBusy(true);
    try {
      await call("adminReverseTransfer", { txId: t.txId, reason: reason.trim() });
      toast.success("Transfer reversed");
      await select(selected);
      await loadUsers(search);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return <p className="py-12 text-center text-sm text-muted-foreground">You don&apos;t have access to this page.</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Payments held for review</CardTitle>
            <CardDescription>Flagged by fraud rules. Sender funds are reserved until you decide.</CardDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={loadHolds}>Refresh</Button>
        </CardHeader>
        <CardContent>
          {holds.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Nothing to review.</p>
          ) : (
            <ul className="divide-y text-sm">
              {holds.map((h) => (
                <li key={h.holdId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium tabular-nums">{formatCents(h.amountCents)}</span> {h.fromEmail} → {h.toEmail}
                    <span className="block text-xs text-muted-foreground">{when(h.createdAt)} · {h.reasons.join("; ")}</span>
                  </span>
                  <span className="flex gap-1">
                    <Button size="sm" disabled={busy} onClick={() => decide(h, "approve")}>Approve</Button>
                    <Button size="sm" variant="destructive" disabled={busy} onClick={() => decide(h, "reject")}>Reject</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
            <form className="flex gap-2 pt-2" onSubmit={(e) => { e.preventDefault(); loadUsers(search); }}>
              <Input placeholder="Email starts with…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <Button type="submit" variant="outline">Search</Button>
            </form>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {users.map((u) => (
                <li key={u.uid}>
                  <button onClick={() => select(u)}
                    className={`flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-sm hover:bg-muted ${selected?.uid === u.uid ? "bg-muted" : ""}`}>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{u.email}</span>
                      <span className="text-xs text-muted-foreground">KYC {u.kycStatus} · tier {u.tier}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {u.frozen && <Badge variant="destructive">frozen</Badge>}
                      <span className="tabular-nums">{formatCents(u.balanceCents)}</span>
                    </span>
                  </button>
                </li>
              ))}
              {users.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">No users found.</li>}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {selected && (
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-2">
                <div>
                  <CardTitle className="break-all">{selected.email}</CardTitle>
                  <CardDescription className="break-all">{selected.uid}</CardDescription>
                </div>
                <div className="flex gap-1">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setTier(selected)}>Tier {selected.tier}</Button>
                  <Button variant={selected.frozen ? "outline" : "destructive"} size="sm" disabled={busy} onClick={() => toggleFreeze(selected)}>
                    {selected.frozen ? "Unfreeze" : "Freeze"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <p className="mb-2 text-sm font-medium">Transfers</p>
                {transfers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No transfers.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {transfers.map((t) => (
                      <li key={t.txId} className="flex items-center justify-between gap-2 py-2">
                        <span className="min-w-0">
                          <span className="font-medium">{t.fromUid === selected.uid ? "Sent" : "Received"} {formatCents(t.amountCents)}</span>
                          {t.reversalOf && <Badge variant="outline" className="ml-2">reversal</Badge>}
                          {t.reversedBy && <Badge variant="secondary" className="ml-2">reversed</Badge>}
                          <span className="block truncate text-xs text-muted-foreground">{when(t.createdAt)} · {t.note || t.txId}</span>
                        </span>
                        {!t.reversalOf && !t.reversedBy && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => reverse(t)}>Reverse</Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Audit log{selected ? ` · ${selected.email}` : ""}</CardTitle>
              {selected && <Button size="sm" variant="ghost" onClick={() => select(null)}>Show all</Button>}
            </CardHeader>
            <CardContent>
              <ul className="max-h-[32rem] divide-y overflow-y-auto text-sm">
                {audit.map((a) => (
                  <li key={a.id} className="py-2">
                    <div className="flex justify-between gap-2">
                      <span className="font-mono text-xs">{a.action}</span>
                      <span className="text-xs text-muted-foreground">{when(a.createdAt)}</span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.actorUid}{a.ip ? ` · ${a.ip}` : ""} · {JSON.stringify(a.metadata)}
                    </p>
                  </li>
                ))}
                {audit.length === 0 && <li className="py-6 text-center text-muted-foreground">No entries.</li>}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
