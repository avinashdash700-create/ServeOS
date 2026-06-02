import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Users, Sparkles, Activity, Settings, Zap, History, Archive } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/lib/auth";
import { buildActiveReminders, fetchLastSentMap, type ReminderClient, type ReminderFollowUp } from "@/lib/follow-up";

const items = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard, key: null },
  { title: "Clients", url: "/clients", icon: Users, key: "clients" as const },
  { title: "Outreach Drafts", url: "/outreach", icon: Sparkles, key: "outreach" as const },
  { title: "Archived Drafts", url: "/archived", icon: Archive, key: "archived" as const },
  { title: "Engagement Centre", url: "/engagement", icon: Activity, key: "engagement" as const },
  { title: "History", url: "/history", icon: History, key: "history" as const },
  { title: "Settings", url: "/settings", icon: Settings, key: null },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  const { user } = useSession();
  const [counts, setCounts] = useState<{ clients: number; outreach: number; archived: number; engagement: number; history: number }>({
    clients: 0, outreach: 0, archived: 0, engagement: 0, history: 0,
  });
  const [bump, setBump] = useState(0);

  useEffect(() => {
    if (!user) {
      setCounts({ clients: 0, outreach: 0, archived: 0, engagement: 0, history: 0 });
      return;
    }
    let cancelled = false;
    const load = async () => {
      const [clientsRes, outreachRes, archivedRes, clientsData, followUpsData, historyRes, lastSentMap] = await Promise.all([
        supabase.from("clients").select("id", { count: "exact", head: true }),
        supabase.from("outreach_drafts").select("id", { count: "exact", head: true }).eq("archived", false).eq("sent", false),
        supabase.from("outreach_drafts").select("id", { count: "exact", head: true }).eq("archived", true),
        supabase.from("clients").select("id, name, email, notes, tags, last_contacted, status").eq("user_id", user.id),
        supabase.from("follow_ups").select("id, client_id, done, status, snoozed_until, draft_id").eq("user_id", user.id),
        supabase.from("activity_history").select("id", { count: "exact", head: true }),
        fetchLastSentMap(user.id),
      ]);
      if (cancelled) return;
      const engagementCount = buildActiveReminders(
        (clientsData.data ?? []) as ReminderClient[],
        (followUpsData.data ?? []) as ReminderFollowUp[],
        lastSentMap,
      ).length;
      setCounts((prev) => {
        if (prev.engagement !== engagementCount) setBump((b) => b + 1);
        return {
          clients: clientsRes.count ?? 0,
          outreach: outreachRes.count ?? 0,
          archived: archivedRes.count ?? 0,
          engagement: engagementCount,
          history: historyRes.count ?? 0,
        };
      });
    };
    load();

    const channel = supabase
      .channel("sidebar-counts")
      .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "outreach_drafts" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "follow_ups" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "activity_history" }, load)
      .subscribe();
    // Re-check periodically so expired snoozes flip back to active.
    const interval = window.setInterval(load, 60_000);

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      window.clearInterval(interval);
    };
  }, [user, currentPath]);


  const countFor = (key: string | null) => {
    if (!key) return null;
    if (key === "clients") return counts.clients;
    if (key === "outreach") return counts.outreach;
    if (key === "archived") return counts.archived;
    if (key === "engagement") return counts.engagement;
    if (key === "history") return counts.history;
    return null;
  };

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="border-b border-sidebar-border/60">
        <Link to="/dashboard" className="flex items-center gap-2.5 px-2 py-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Zap className="h-4.5 w-4.5" />
          </div>
          {!collapsed && (
            <div className="flex flex-col">
              <span className="text-sm font-semibold tracking-tight">ServeOS</span>
              <span className="text-[11px] text-muted-foreground">AI CRM for solos</span>
            </div>
          )}
        </Link>
      </SidebarHeader>
      <SidebarContent className="py-2">
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {items.map((item) => {
                const active = currentPath === item.url;
                const count = countFor(item.key);
                const showCount = count !== null && count > 0;
                const isEngagement = item.key === "engagement";

                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      className={
                        active
                          ? "bg-accent text-accent-foreground font-medium hover:bg-accent"
                          : "text-sidebar-foreground/80 hover:bg-muted hover:text-foreground"
                      }
                    >
                      <Link to={item.url} className="flex w-full items-center gap-2.5 transition-colors">
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && (
                          <>
                            <span className="text-[13.5px]">{item.title}</span>
                            {showCount && (
                              <span
                                key={isEngagement ? `eng-${bump}` : undefined}
                                className={
                                  "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums bg-muted text-muted-foreground transition-colors " +
                                  (isEngagement ? "animate-in zoom-in-50 duration-300" : "")

                                }
                              >

                                {count}
                              </span>
                            )}
                          </>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
