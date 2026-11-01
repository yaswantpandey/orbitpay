"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Wallet,
  Send,
  QrCode,
  History,
  Grid,
  PlusCircle,
  Landmark,
  Coins,
  PiggyBank,
  Users,
  Split,
  Repeat,
  FileText,
  Store,
  BarChart3,
  Settings,
  LogOut,
  HandCoins,
} from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { signOut } from "@/lib/auth";

export function MobileNav() {
  const { user, mfaEnrolled } = useAuth();
  const pathname = usePathname();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!user || !mfaEnrolled) return null;

  const isHome = pathname === "/dashboard";
  const isSend = pathname === "/send";
  const isQr = pathname === "/contacts";
  const isHistory = pathname === "/history";
  const isHubActive = [
    "/add-money",
    "/withdraw",
    "/currencies",
    "/savings",
    "/split",
    "/recurring",
    "/invoices",
    "/merchant",
    "/insights",
    "/settings",
    "/requests",
  ].includes(pathname);

  const HUB_ITEMS = [
    { href: "/add-money", label: "Add money", icon: PlusCircle, color: "text-emerald-500 bg-emerald-500/10" },
    { href: "/requests", label: "Requests", icon: HandCoins, color: "text-blue-500 bg-blue-500/10" },
    { href: "/withdraw", label: "Withdraw", icon: Landmark, color: "text-purple-500 bg-purple-500/10" },
    { href: "/split", label: "Split bill", icon: Split, color: "text-orange-500 bg-orange-500/10" },
    { href: "/savings", label: "Savings", icon: PiggyBank, color: "text-pink-500 bg-pink-500/10" },
    { href: "/currencies", label: "Currencies", icon: Coins, color: "text-amber-500 bg-amber-500/10" },
    { href: "/invoices", label: "Invoices", icon: FileText, color: "text-cyan-500 bg-cyan-500/10" },
    { href: "/recurring", label: "Recurring", icon: Repeat, color: "text-indigo-500 bg-indigo-500/10" },
    { href: "/insights", label: "Insights", icon: BarChart3, color: "text-teal-500 bg-teal-500/10" },
    { href: "/merchant", label: "Merchant", icon: Store, color: "text-rose-500 bg-rose-500/10" },
    { href: "/contacts", label: "Contacts & QR", icon: Users, color: "text-sky-500 bg-sky-500/10" },
    { href: "/settings", label: "Settings", icon: Settings, color: "text-gray-500 bg-gray-500/10" },
  ];

  return (
    <>
      <nav
        aria-label="Mobile Navigation"
        className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/90 backdrop-blur-xl md:hidden pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_20px_rgba(0,0,0,0.05)] dark:shadow-[0_-4px_20px_rgba(0,0,0,0.3)]"
      >
        <div className="flex h-16 items-center justify-around px-2">
          {/* 1. Wallet / Home */}
          <Link
            href="/dashboard"
            className={`flex flex-1 flex-col items-center justify-center gap-1 py-1 text-[11px] font-medium transition active:scale-95 ${
              isHome ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Wallet className={`size-5 ${isHome ? "stroke-[2.5]" : ""}`} />
            <span>Wallet</span>
          </Link>

          {/* 2. Send */}
          <Link
            href="/send"
            className={`flex flex-1 flex-col items-center justify-center gap-1 py-1 text-[11px] font-medium transition active:scale-95 ${
              isSend ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Send className={`size-5 ${isSend ? "stroke-[2.5]" : ""}`} />
            <span>Send</span>
          </Link>

          {/* 3. Center Elevated Action Button: Scan / QR */}
          <div className="flex flex-1 items-center justify-center -mt-5">
            <Link
              href="/contacts"
              className={`flex size-13 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/25 transition active:scale-90 ${
                isQr ? "ring-4 ring-primary/20" : ""
              }`}
              aria-label="Scan or Show QR Code"
            >
              <QrCode className="size-6 stroke-[2.2]" />
            </Link>
          </div>

          {/* 4. Activity */}
          <Link
            href="/history"
            className={`flex flex-1 flex-col items-center justify-center gap-1 py-1 text-[11px] font-medium transition active:scale-95 ${
              isHistory ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <History className={`size-5 ${isHistory ? "stroke-[2.5]" : ""}`} />
            <span>Activity</span>
          </Link>

          {/* 5. Hub / More Sheet */}
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger
              className={`flex flex-1 flex-col items-center justify-center gap-1 py-1 text-[11px] font-medium transition active:scale-95 ${
                isHubActive ? "text-primary font-bold" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Grid className={`size-5 ${isHubActive ? "stroke-[2.5]" : ""}`} />
              <span>Hub</span>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-3xl pb-8 max-h-[85vh] overflow-y-auto">
              <SheetHeader className="text-left pb-2">
                <SheetTitle className="text-lg font-bold">OrbitPay Hub</SheetTitle>
                <SheetDescription className="text-xs">
                  All tools, currencies and payment features in one place.
                </SheetDescription>
              </SheetHeader>

              {/* Grid of Tools */}
              <div className="grid grid-cols-4 gap-3 py-4">
                {HUB_ITEMS.map(({ href, label, icon: Icon, color }) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setSheetOpen(false)}
                    className="flex flex-col items-center gap-1.5 text-center active:scale-90 transition group"
                  >
                    <div className={`flex size-12 items-center justify-center rounded-2xl ${color} shadow-xs transition group-hover:scale-105`}>
                      <Icon className="size-6" />
                    </div>
                    <span className="text-[11px] font-medium leading-tight max-w-[65px] truncate">
                      {label}
                    </span>
                  </Link>
                ))}
              </div>

              {/* Sign out */}
              <div className="border-t pt-3 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setSheetOpen(false);
                    signOut();
                  }}
                  className="w-full flex items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-semibold text-destructive bg-destructive/10 hover:bg-destructive/15 transition active:scale-98"
                >
                  <LogOut className="size-4" />
                  <span>Sign out of OrbitPay</span>
                </button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
    </>
  );
}
