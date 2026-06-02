import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setLoading(false);
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, user: session?.user ?? null, loading };
}

export function userInitials(user: User | null, fallback = "U") {
  const name =
    (user?.user_metadata as { full_name?: string } | undefined)?.full_name ||
    user?.email ||
    fallback;
  return name
    .split(/[\s@]/)
    .filter(Boolean)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function userDisplayName(user: User | null) {
  const meta = user?.user_metadata as { full_name?: string } | undefined;
  return meta?.full_name || user?.email?.split("@")[0] || "Account";
}
