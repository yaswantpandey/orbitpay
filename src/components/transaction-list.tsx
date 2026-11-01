"use client";

import { deleteDoc, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/firebase";
import { formatCents } from "@/lib/format";
import { useDisplayRate } from "@/lib/hooks";
import { CATEGORIES } from "@/lib/schemas";
import type { LedgerEntry, LedgerEntryType } from "@/types";

const LABELS: Record<LedgerEntryType, string> = {
  topup: "Added money",
  transfer_in: "Received",
  transfer_out: "Sent",
  fee: "Fee",
  refund: "Refund",
  payout: "Withdrawal",
  fx_in: "Converted in",
  fx_out: "Converted out",
  savings_in: "To savings",
  savings_out: "From savings",
  hold: "Held for review",
};

/** Moves within your own accounts aren't spending, so they can't be categorised. */
const INTERNAL = new Set<LedgerEntryType>(["fx_in", "fx_out", "savings_in", "savings_out", "hold"]);

/** `categorize` shows a category picker on outgoing entries (saved in `/ledgerTags/{entryId}`). */
export function TransactionList({ entries, categorize = false, onCategorized }: {
  entries: LedgerEntry[];
  categorize?: boolean;
  onCategorized?: (id: string, category: string) => void;
}) {
  const { user } = useAuth();
  const { currency, rate } = useDisplayRate();

  const setCategory = async (id: string, category: string) => {
    if (!user) return;
    try {
      if (category) {
        await setDoc(doc(db, "ledgerTags", id), {
          uid: user.uid,
          category,
          updatedAt: serverTimestamp(),
        });
      } else {
        await deleteDoc(doc(db, "ledgerTags", id));
      }
      onCategorized?.(id, category);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (entries.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No transactions yet.</p>;
  }
  return (
    <ul className="divide-y">
      {entries.map((e) => {
        const credit = e.amountCents > 0;
        return (
          <li key={e.id} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{LABELS[e.type]}</span>
                <Badge variant="outline">{e.type.replace("_", " ")}</Badge>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {e.counterpartyEmail ? (credit ? "from " : "to ") + e.counterpartyEmail : e.note}
                {e.counterpartyEmail && e.note ? ` — ${e.note}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">{e.createdAt?.toDate().toLocaleString() ?? "…"}</p>
              {categorize && !credit && !INTERNAL.has(e.type) && (
                <select aria-label="Category" value={e.category ?? ""} onChange={(ev) => void setCategory(e.id, ev.target.value)}
                  className="mt-1 h-6 rounded border bg-background px-1 text-xs capitalize">
                  <option value="">Uncategorised</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              {!categorize && e.category && <Badge variant="secondary" className="mt-1 capitalize">{e.category}</Badge>}
            </div>
            <div className="text-right">
              <p className={`font-semibold tabular-nums ${credit ? "text-green-600" : "text-red-600"}`}>
                {credit ? "+" : "−"}{formatCents(Math.abs(e.amountCents))}
              </p>
              {currency !== "USD" && (
                <p className="text-xs text-muted-foreground">≈ {formatCents(Math.abs(e.amountCents), currency, rate)}</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
