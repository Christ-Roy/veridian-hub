"use client"

import type { LucideIcon } from "lucide-react"
import Link from "next/link"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function NavMain({
  items,
}: {
  items: {
    title: string
    url: string
    icon?: LucideIcon
    disabled?: boolean
  }[]
}) {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              {item.disabled ? (
                <SidebarMenuButton
                  tooltip={item.title + " (Prochainement)"}
                  className="text-muted-foreground cursor-not-allowed opacity-50"
                >
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                  <span className="ml-auto text-xs">Bientôt</span>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton
                  tooltip={item.title}
                  asChild
                  className={item.title === "Dashboard" ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""}
                >
                  <Link href={item.url}>
                    {item.icon && <item.icon />}
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
