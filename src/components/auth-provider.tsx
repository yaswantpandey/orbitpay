"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { onAuthStateChanged, User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { hasTotp } from "@/lib/auth";
import type { UserProfile } from "@/types";

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  mfaEnrolled: boolean;
}

const AuthContext = createContext<AuthState>({
  user: null,
  profile: null,
  loading: true,
  mfaEnrolled: false,
});

export const useAuth = () => useContext(AuthContext);

const PUBLIC_ROUTES = ["/", "/login", "/signup"];
const RETURN_KEY = "orbitpay.returnTo";
// In the emulator, TOTP is not supported, so 2FA enrollment is skipped there.
// NEXT_PUBLIC_DISABLE_MFA=true temporarily turns 2FA off everywhere.
const SKIP_MFA =
  process.env.NEXT_PUBLIC_USE_EMULATORS === "true" || process.env.NEXT_PUBLIC_DISABLE_MFA === "true";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => onAuthStateChanged(auth, (u) => {
    setUser(u);
    if (!u) setProfile(null);
    setLoading(false);
  }), []);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid), (snap) =>
      setProfile(snap.exists() ? (snap.data() as UserProfile) : null)
    );
  }, [user]);

  const mfaEnrolled = !!user && (SKIP_MFA || hasTotp(user));

  useEffect(() => {
    if (loading) return;
    const isPublic = PUBLIC_ROUTES.includes(pathname);
    if (!user && !isPublic) {
      // Remember deep links (e.g. a scanned /pay QR) so sign-in lands back on them.
      sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
      router.replace("/login");
    } else if (user && !mfaEnrolled && pathname !== "/setup-2fa") {
      router.replace("/setup-2fa");
    } else if (user && mfaEnrolled && (pathname === "/" || pathname === "/login" || pathname === "/signup" || pathname === "/setup-2fa")) {
      const back = sessionStorage.getItem(RETURN_KEY);
      sessionStorage.removeItem(RETURN_KEY);
      // Same-origin relative paths only, to avoid an open redirect.
      router.replace(back && back.startsWith("/") && !back.startsWith("//") && back !== "/" ? back : "/dashboard");
    }
  }, [loading, user, mfaEnrolled, pathname, router]);

  return (
    <AuthContext.Provider value={{ user, profile, loading, mfaEnrolled }}>
      {children}
    </AuthContext.Provider>
  );
}
