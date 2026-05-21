"use client"

import * as React from "react"
import Link from "next/link"
import {
  FileIcon,
  HelpCircleIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  Users2Icon,
  ZapIcon,
} from "lucide-react"

import Logo from "@/components/icons/Logo"
import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { NavUser } from "@/components/nav-user"
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const navMain = [
  {
    title: "Dashboard",
    url: "/dashboard",
    icon: LayoutDashboardIcon,
  },
  {
    title: "Integration",
    url: "/dashboard/integration",
    icon: ZapIcon,
    disabled: true,
  },
  {
    title: "Membres",
    url: "/dashboard/workspace/members",
    icon: Users2Icon,
  },
  {
    title: "Billing",
    url: "/dashboard/billing",
    icon: FileIcon,
  },
  {
    title: "Settings",
    url: "/dashboard/settings",
    icon: SettingsIcon,
  },
];

const navSecondary = [
  {
    title: "Get Help",
    url: "#",
    icon: HelpCircleIcon,
  },
];

export function AppSidebar({
  user,
  workspaceName,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: {
    name: string;
    email: string;
    avatar: string;
  };
  /**
   * Nom du workspace courant. Affiché sous le logo Veridian pour rendre
   * l'objet visible (régression 2026-05-21 : workspaces invisibles côté UI).
   * Optionnel pour rester rétro-compatible — si absent, on n'affiche rien.
   */
  workspaceName?: string | null;
}) {
  const appName = "Veridian";

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            >
              <Link href="/">
                <Logo className="h-6 w-6" />
                <span className="text-base font-semibold">{appName}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {workspaceName ? (
            <SidebarMenuItem>
              <div
                className="px-2 py-1 text-xs text-muted-foreground truncate"
                data-testid="sidebar-workspace-name"
                title={workspaceName}
              >
                {workspaceName}
              </div>
            </SidebarMenuItem>
          ) : null}
        </SidebarMenu>
        <div className="px-3 py-2">
          <AnimatedThemeToggler />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        <NavSecondary items={navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  )
}
