import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useSession } from "@/lib/auth";

export const Route = createFileRoute("/")({
  component: IndexRedirect,
});

function IndexRedirect() {
  const { session, loading } = useSession();
  if (loading) return <div className="min-h-screen bg-background" />;
  return <Navigate to={session ? "/dashboard" : "/login"} replace />;
}
