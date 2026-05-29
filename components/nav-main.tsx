"use client"

import type { LucideIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

/**
 * Détermine si un item de nav correspond à la route courante.
 * `/dashboard` (la racine) ne matche QU'exactement, sinon il resterait
 * actif sur toutes les sous-pages. Les autres matchent aussi leurs
 * sous-routes (ex. /dashboard/billing actif sur /dashboard/billing/xxx).
 */
function isItemActive(pathname: string | null, url: string): boolean {
  // `usePathname()` peut renvoyer null (avant hydratation / hors contexte
  // router en test). Aucun item n'est actif dans ce cas.
  if (!pathname) return false
  if (url === "/dashboard") return pathname === "/dashboard"
  return pathname === url || pathname.startsWith(url + "/")
}

export function NavMain({
  items,
}: {
  items: {
    title: string
    url: string
    icon?: LucideIcon
    disabled?: boolean
    badge?: string
  }[]
}) {
  const pathname = usePathname()
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const active = !item.disabled && isItemActive(pathname, item.url)
            return (
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
                  isActive={active}
                  className="data-[active=true]:bg-primary data-[active=true]:text-primary-foreground data-[active=true]:font-medium"
                >
                  <Link href={item.url}>
                    {item.icon && <item.icon />}
                    <span>{item.title}</span>
                    {item.badge && (
                      <span className="ml-auto rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
