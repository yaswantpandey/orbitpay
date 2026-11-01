"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, doc, limit, onSnapshot, orderBy, query, where, Query } from "firebase/firestore";
import { db } from "./firebase";
import { useAuth } from "@/components/auth-provider";
import type {
  AppNotification, ApiKey, Checkout, Contact, CurrencyBalance, FxRates, Hold, Invoice, LedgerEntry, Merchant, MonthStat,
  PaymentRequest, Payout, Pot, Schedule, Split, Topup, Wallet, WebhookDelivery,
} from "@/types";

/** Generic live query scoped to the signed-in user. `build` returns null to skip. */
function useLive<T>(build: (uid: string) => Query | null, deps: unknown[]): T[] {
  const { user } = useAuth();
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    if (!user) return;
    const q = build(user.uid);
    if (!q) return;
    return onSnapshot(q, (s) => setItems(s.docs.map((d) => ({ id: d.id, ...d.data() }) as T)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, ...deps]);
  return items;
}

export const usePayouts = () => useLive<Payout>((uid) =>
  query(collection(db, "payouts"), where("uid", "==", uid), orderBy("createdAt", "desc"), limit(50)), []);

export const useSchedules = () => useLive<Schedule>((uid) =>
  query(collection(db, "schedules"), where("ownerUid", "==", uid), orderBy("createdAt", "desc"), limit(100)), []);

export const useSplits = () => useLive<Split>((uid) =>
  query(collection(db, "splits"), where("ownerUid", "==", uid), orderBy("createdAt", "desc"), limit(50)), []);

export const useContacts = () => useLive<Contact>((uid) =>
  query(collection(db, "users", uid, "contacts"), orderBy("name"), limit(200)), []);

export const useMonthStats = (months = 6) => useLive<MonthStat>((uid) =>
  query(collection(db, "stats"), where("uid", "==", uid), orderBy("month", "desc"), limit(months)), [months]);

export const useBalances = () => useLive<CurrencyBalance>((uid) =>
  query(collection(db, "balances"), where("uid", "==", uid)), []);

export const usePots = () => useLive<Pot>((uid) =>
  query(collection(db, "pots"), where("uid", "==", uid), orderBy("createdAt", "asc")), []);

export const useApiKeys = () => useLive<ApiKey>((uid) =>
  query(collection(db, "apiKeys"), where("uid", "==", uid), orderBy("createdAt", "desc")), []);

export const useCheckouts = () => useLive<Checkout>((uid) =>
  query(collection(db, "checkouts"), where("merchantUid", "==", uid), orderBy("createdAt", "desc"), limit(50)), []);

export const useWebhookDeliveries = () => useLive<WebhookDelivery>((uid) =>
  query(collection(db, "webhookDeliveries"), where("merchantUid", "==", uid), orderBy("createdAt", "desc"), limit(50)), []);

export const useHolds = () => useLive<Hold>((uid) =>
  query(collection(db, "holds"), where("fromUid", "==", uid), orderBy("createdAt", "desc"), limit(20)), []);

export function useMerchant() {
  const { user } = useAuth();
  const [m, setM] = useState<Merchant | null | undefined>(undefined);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "merchants", user.uid), (s) => setM(s.exists() ? (s.data() as Merchant) : null));
  }, [user]);
  return m;
}

/** Admin is a custom auth claim; the UI check is cosmetic, the server enforces it. */
export function useIsAdmin() {
  const { user } = useAuth();
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    if (!user) return;
    user.getIdTokenResult().then((t) => setAdmin(t.claims.admin === true)).catch(() => setAdmin(false));
  }, [user]);
  return user ? admin : false;
}

export function usePaymentRequests() {
  const { user } = useAuth();
  const [items, setItems] = useState<PaymentRequest[]>([]);
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "paymentRequests"), where("participants", "array-contains", user.uid),
      orderBy("createdAt", "desc"), limit(100));
    return onSnapshot(q, (s) => setItems(s.docs.map((d) => ({ id: d.id, ...d.data() }) as PaymentRequest)));
  }, [user]);
  return items;
}

/** Invoices I issued, and invoices addressed to my email. */
export function useInvoices() {
  const { user } = useAuth();
  const [issued, setIssued] = useState<Invoice[]>([]);
  const [received, setReceived] = useState<Invoice[]>([]);
  useEffect(() => {
    if (!user?.email) return;
    const map = (s: { docs: { id: string; data: () => object }[] }) =>
      s.docs.map((d) => ({ id: d.id, ...d.data() }) as Invoice);
    const u1 = onSnapshot(query(collection(db, "invoices"), where("issuerUid", "==", user.uid),
      orderBy("createdAt", "desc"), limit(100)), (s) => setIssued(map(s)));
    const u2 = onSnapshot(query(collection(db, "invoices"), where("recipientEmail", "==", user.email.toLowerCase()),
      orderBy("createdAt", "desc"), limit(100)), (s) => setReceived(map(s)));
    return () => { u1(); u2(); };
  }, [user]);
  return { issued, received };
}

export function useNotifications(max = 20) {
  const { user } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "notifications"), where("uid", "==", user.uid), orderBy("createdAt", "desc"), limit(max));
    return onSnapshot(q, (s) => setItems(s.docs.map((d) => ({ id: d.id, ...d.data() }) as AppNotification)));
  }, [user, max]);
  return items;
}

export function useWallet() {
  const { user } = useAuth();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "wallets", user.uid), (s) => setWallet(s.exists() ? (s.data() as Wallet) : null));
  }, [user]);
  return wallet;
}

export function useLedgerTags() {
  const { user } = useAuth();
  const [tags, setTags] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "ledgerTags"), where("uid", "==", user.uid));
    return onSnapshot(q, (snap) => {
      const map: Record<string, string> = {};
      snap.docs.forEach((d) => {
        const cat = d.data().category;
        if (typeof cat === "string") map[d.id] = cat;
      });
      setTags(map);
    });
  }, [user]);
  return tags;
}

export function useLedger(max = 50) {
  const tags = useLedgerTags();
  const { user } = useAuth();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "ledger"), where("uid", "==", user.uid), orderBy("createdAt", "desc"), limit(max));
    return onSnapshot(q, (s) => setEntries(s.docs.map((d) => ({ id: d.id, ...d.data() }) as LedgerEntry)));
  }, [user, max]);
  return useMemo(() => entries.map((e) => ({ ...e, category: tags[e.id] ?? e.category })), [entries, tags]);
}

export function usePendingTopups() {
  const { user } = useAuth();
  const [topups, setTopups] = useState<Topup[]>([]);
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "topups"), where("uid", "==", user.uid), where("status", "in", ["pending", "processing"]),
      orderBy("createdAt", "desc"));
    return onSnapshot(q, (s) => setTopups(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Topup)));
  }, [user]);
  return topups;
}

/** Indicative display rate for the user's chosen currency. Ledger is always USD. */
export function useDisplayRate() {
  const { user, profile } = useAuth();
  const [fx, setFx] = useState<FxRates | null>(null);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "fxRates", "latest"), (s) => setFx(s.exists() ? (s.data() as FxRates) : null));
  }, [user]);
  const currency = profile?.displayCurrency ?? "USD";
  const rate = currency === "USD" ? 1 : fx?.rates[currency];
  return rate ? { currency, rate, fetchedAt: fx?.fetchedAt } : { currency: "USD", rate: 1, fetchedAt: undefined };
}
