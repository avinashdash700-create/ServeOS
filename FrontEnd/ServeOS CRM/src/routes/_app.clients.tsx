import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Plus, Search, X, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/auth";
import { toast } from "sonner";
import { daysSince, fetchLastSentMap, getFollowUpStatus, statusBadgeClasses } from "@/lib/follow-up";
import { logActivity } from "@/lib/outreach";

export const Route = createFileRoute("/_app/clients")({
  head: () => ({ meta: [{ title: "Clients — ServeOS" }] }),
  component: ClientsPage,
});

type Client = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  notes: string | null;
  last_contacted: string | null;
  status: string | null;
};

const emptyForm = { name: "", email: "", phone: "", tags: "", notes: "", lastContacted: "" };
type FormState = typeof emptyForm;

function ClientsPage() {
  const { user } = useSession();
  const [clients, setClients] = useState<Client[]>([]);
  const [lastSentMap, setLastSentMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; stage: 1 | 2 } | null>(null);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const [{ data, error }, sentMap] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, email, phone, tags, notes, last_contacted, status")
        .order("created_at", { ascending: false }),
      user ? fetchLastSentMap(user.id) : Promise.resolve(new Map<string, string>()),
    ]);
    if (error) toast.error(error.message);
    else setClients((data ?? []) as Client[]);
    setLastSentMap(sentMap);
    setLoading(false);
  };

  useEffect(() => {
    if (user) load();
  }, [user]);

  // Refresh when a successful send (or any other write) flips clients.status.
  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel("clients-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_drafts" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "follow_ups" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    clients.forEach((c) => c.tags.forEach((t) => set.add(t)));
    return [...set].sort();
  }, [clients]);

  const filtered = useMemo(() => {
    return clients.filter((c) => {
      const matchesQ =
        !query ||
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        (c.email ?? "").toLowerCase().includes(query.toLowerCase());
      const matchesTags =
        activeTags.length === 0 || activeTags.every((t) => c.tags.includes(t));
      return matchesQ && matchesTags;
    });
  }, [clients, query, activeTags]);

  const toggleTag = (t: string) =>
    setActiveTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allVisibleSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));
  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((c) => c.id)));
    }
  };

  const performDelete = async (ids: string[]) => {
    const names = clients.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, name: c.name }));
    const { error } = await supabase.from("clients").delete().in("id", ids);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(`${ids.length} ${ids.length === 1 ? "client" : "clients"} deleted`);
      if (user) {
        for (const n of names) {
          await logActivity({
            user_id: user.id,
            client_id: n.id,
            client_name: n.name,
            action_type: "client_deleted",
            action_source: "clients_page",
            details: `Deleted client ${n.name}`,
          });
        }
      }
      setSelected(new Set());
      load();
    }
    setConfirmDelete(null);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage your relationships in one place.</p>
        </div>
        <ClientFormDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          userId={user?.id}
          onSaved={load}
          trigger={<Button className="gap-2"><Plus className="h-4 w-4" /> Add Client</Button>}
        />
      </div>

      <Card className="border-border/60 shadow-[var(--shadow-soft)]">
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full md:max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name or email…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {filtered.length} {filtered.length === 1 ? "client" : "clients"}
            </CardTitle>
          </div>
          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Filter tags:</span>
              {allTags.map((t) => {
                const active = activeTags.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleTag(t)}
                    className={`rounded-full border px-3 py-1 text-xs transition ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {t}
                  </button>
                );
              })}
              {activeTags.length > 0 && (
                <button
                  onClick={() => setActiveTags([])}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
            </div>
          )}

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
              <span className="text-sm font-medium">
                {selected.size} selected
              </span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="gap-1" onClick={() => setBulkEditOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" /> Bulk edit
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="gap-1"
                  onClick={() => setConfirmDelete({ ids: [...selected], stage: 1 })}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete selected
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Last contacted</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => {
                const status = getFollowUpStatus(c.last_contacted, c.status, lastSentMap.get(c.id) ?? null);
                const isSelected = selected.has(c.id);
                return (
                  <TableRow key={c.id} data-state={isSelected ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelect(c.id)}
                        aria-label={`Select ${c.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.email}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.phone}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {c.tags.map((t) => (
                          <Badge key={t} variant="secondary" className="font-normal">{t}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[220px] text-sm text-muted-foreground">
                      <span className="line-clamp-2">{c.notes || "—"}</span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.last_contacted ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`font-normal ${statusBadgeClasses(status)}`}>
                        {status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => setEditing(c)}
                          aria-label={`Edit ${c.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setConfirmDelete({ ids: [c.id], stage: 1 })}
                          aria-label={`Delete ${c.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-12 text-center text-sm text-muted-foreground">
                    {clients.length === 0 ? "No clients yet — add your first one." : "No clients match your filters."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editing && (
        <ClientFormDialog
          open={!!editing}
          onOpenChange={(v) => !v && setEditing(null)}
          userId={user?.id}
          onSaved={() => { setEditing(null); load(); }}
          existing={editing}
        />
      )}

      <BulkEditDialog
        open={bulkEditOpen}
        onOpenChange={setBulkEditOpen}
        ids={[...selected]}
        onSaved={() => { setBulkEditOpen(false); setSelected(new Set()); load(); }}
      />

      {/* Two-stage delete confirmation */}
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(v) => { if (!v) setConfirmDelete(null); }}
      >
        <AlertDialogContent>
          {confirmDelete?.stage === 1 ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {confirmDelete.ids.length} {confirmDelete.ids.length === 1 ? "client" : "clients"}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently remove the selected client{confirmDelete.ids.length === 1 ? "" : "s"} and related data.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={(e) => { e.preventDefault(); setConfirmDelete({ ...confirmDelete, stage: 2 }); }}
                >
                  Continue
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : confirmDelete ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. Confirm to delete {confirmDelete.ids.length} {confirmDelete.ids.length === 1 ? "client" : "clients"}.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={(e) => { e.preventDefault(); performDelete(confirmDelete.ids); }}
                >
                  Yes, delete permanently
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ClientFormDialog({
  open, onOpenChange, userId, onSaved, existing, trigger,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  userId?: string;
  onSaved: () => void;
  existing?: Client;
  trigger?: React.ReactNode;
}) {
  const isEdit = !!existing;
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(existing ? {
        name: existing.name,
        email: existing.email ?? "",
        phone: existing.phone ?? "",
        tags: existing.tags.join(", "),
        notes: existing.notes ?? "",
        lastContacted: existing.last_contacted ?? "",
      } : emptyForm);
    }
  }, [open, existing]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.phone.trim()) {
      toast.error("Name, Email and Phone are required");
      return;
    }
    if (!userId) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      notes: form.notes || null,
      last_contacted: form.lastContacted || null,
    };
    const { data: saved, error } = isEdit
      ? await supabase.from("clients").update(payload).eq("id", existing!.id).select("id, name").single()
      : await supabase.from("clients").insert({ ...payload, user_id: userId }).select("id, name").single();
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(isEdit ? "Client updated" : `${payload.name} added to clients`);
    if (userId && saved) {
      await logActivity({
        user_id: userId,
        client_id: saved.id,
        client_name: saved.name,
        action_type: isEdit ? "client_updated" : "client_added",
        action_source: "clients_page",
        details: isEdit ? `Updated client ${saved.name}` : `Added client ${saved.name}`,
      });
    }
    onOpenChange(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit client" : "Add a new client"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update this client's information." : "Capture the essentials — you can refine details later."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Name" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email" required>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </Field>
            <Field label="Phone" required>
              <Input
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={15}
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 15) })}
                onKeyDown={(e) => {
                  if (
                    ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) ||
                    e.metaKey || e.ctrlKey
                  ) return;
                  if (!/^[0-9]$/.test(e.key)) e.preventDefault();
                }}
                required
              />
            </Field>

          </div>
          <Field label="Last contacted">
            <Input type="date" value={form.lastContacted} onChange={(e) => setForm({ ...form, lastContacted: e.target.value })} />
          </Field>
          <Field label="Tags" hint="Comma separated">
            <Input placeholder="VIP, Coaching" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </Field>
          <Field label="Notes">
            <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : isEdit ? "Save changes" : "Save client"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BulkEditDialog({
  open, onOpenChange, ids, onSaved,
}: { open: boolean; onOpenChange: (v: boolean) => void; ids: string[]; onSaved: () => void }) {
  const [tags, setTags] = useState("");
  const [lastContacted, setLastContacted] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setTags(""); setLastContacted(""); }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const update: { tags?: string[]; last_contacted?: string } = {};
    if (tags.trim()) update.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (lastContacted) update.last_contacted = lastContacted;
    if (Object.keys(update).length === 0) {
      toast.error("Set at least one field to update");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("clients").update(update).in("id", ids);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Updated ${ids.length} clients`);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk edit {ids.length} clients</DialogTitle>
          <DialogDescription>Only filled fields will be applied. Tags will replace existing ones.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Tags" hint="Comma separated — replaces existing">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="VIP, Coaching" />
          </Field>
          <Field label="Last contacted">
            <Input type="date" value={lastContacted} onChange={(e) => setLastContacted(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Apply to selected"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">
        {label} {required && <span className="text-primary">*</span>}
        {hint && <span className="ml-1 font-normal text-muted-foreground">— {hint}</span>}
      </Label>
      {children}
    </div>
  );
}

// Helper for daysSince in client details (if exposed elsewhere)
export { daysSince };
