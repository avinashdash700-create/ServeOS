import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Zap, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({ meta: [{ title: "Forgot password — ServeOS" }] }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast.error("Please enter your email");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSent(true);
    toast.success("Reset link sent! Check your email.");
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between p-12 text-primary-foreground lg:flex" style={{ background: "var(--gradient-primary)" }}>
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 backdrop-blur">
            <Zap className="h-5 w-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">ServeOS</span>
        </div>
        <div className="space-y-4">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            The AI CRM built for solo service providers.
          </h2>
          <p className="max-w-md text-sm text-white/80">
            Track every client, draft thoughtful outreach in seconds, and never miss a follow-up again.
          </p>
        </div>
        <p className="text-xs text-white/60">© 2026 ServeOS. Crafted for solo operators.</p>
      </div>

      <div className="flex items-center justify-center bg-background p-6 sm:p-12">
        <Card className="w-full max-w-md border-border/60 p-8 shadow-[var(--shadow-soft)]">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Zap className="h-5 w-5" />
            </div>
            <span className="text-lg font-semibold">ServeOS</span>
          </div>

          <Link to="/login" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors mb-4">
            <ArrowLeft className="h-4 w-4" />
            Back to sign in
          </Link>

          <h1 className="text-2xl font-semibold tracking-tight">
            Reset your password
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your email and we&apos;ll send you a reset link.
          </p>

          {sent ? (
            <div className="mt-6 rounded-lg border bg-muted/40 p-6 text-center">
              <p className="text-sm text-muted-foreground">
                If an account exists for <strong>{email}</strong>, you&apos;ll receive a password reset email shortly.
              </p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => {
                  setSent(false);
                  setEmail("");
                }}
              >
                Send again
              </Button>
            </div>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@studio.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" size="lg" disabled={loading}>
                {loading ? "Please wait…" : "Send reset link"}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
