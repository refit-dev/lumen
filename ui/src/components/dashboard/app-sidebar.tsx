"use client";

import * as React from "react";
import {
  BarChart3,
  CreditCard,
  Home,
  Key,
  Receipt,
  Settings,
  ShoppingCart,
  Table,
  Users,
  Percent,
  DollarSign,
  Shield,
  Wallet,
} from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import localFont from "next/font/local";
import { useSession } from "@/lib/auth-client";

const calSans = localFont({
  src: "../../../public/CalSans-Regular.ttf",
  variable: "--font-calsans",
});

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

const data = {
  navMain: [
    {
      title: "Overview",
      items: [
        {
          title: "Dashboard",
          url: "/dashboard",
          icon: Home,
        },
      ],
    },
    {
      title: "Revenue",
      items: [
        {
          title: "Subscriptions",
          url: "/subscriptions",
          icon: CreditCard,
        },
        {
          title: "Payments",
          url: "/payments",
          icon: DollarSign,
        },
        {
          title: "Invoices",
          url: "/invoices",
          icon: Receipt,
        },
      ],
    },
    {
      title: "Product",
      items: [
        {
          title: "Plans",
          url: "/plans",
          icon: ShoppingCart,
        },
        {
          title: "Pricing Table",
          url: "/pricingtable",
          icon: Table,
        },
      ],
    },
    {
      title: "Management",
      items: [
        {
          title: "Customers",
          url: "/customers",
          icon: Users,
        },
        {
          title: "Events",
          url: "/events",
          icon: BarChart3,
        },
        {
          title: "Tax",
          url: "/tax",
          icon: Percent,
        },
      ],
    },
    {
      title: "Settings",
      items: [
        {
          title: "API Keys",
          url: "/developer/apikeys",
          icon: Key,
        },
        {
          title: "Payment Provider",
          url: "/developer/paymentprovider",
          icon: CreditCard,
        },
        {
          title: "Merchant Settings",
          url: "/merchant",
          icon: Settings,
        },
      ],
    },
    {
      title: "Lumen Account & Billing",
      items: [
        {
          title: "Account & Billing",
          url: "/billing",
          icon: Wallet,
        },
      ],
    },
  ],
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  const { state } = useSidebar();
  const { data: session } = useSession();

  // Check if user is admin
  const isAdmin = session?.user?.role === "admin";

  // Create navigation data with conditional admin section
  const navigationData = React.useMemo(() => {
    const nav = [...data.navMain];

    // Add admin section if user is admin
    if (isAdmin) {
      nav.push({
        title: "Admin",
        items: [
          {
            title: "Admin Panel",
            url: "/admin",
            icon: Shield,
          },
          {
            title: "Internal Key Values",
            url: "/admin/internal",
            icon: Settings,
          },
        ],
      });
    }

    return nav;
  }, [isAdmin]);

  return (
    <Sidebar collapsible="icon" className="font-sans" {...props}>
      <SidebarHeader>
        <Link href="/dashboard" className="block">
          <div className="flex items-center gap-3 px-2 py-1 hover:bg-gray-50 rounded-lg transition-colors cursor-pointer">
            <Image
              src="/lumen-logo-black-bg.png"
              alt="Lumen"
              width={32}
              height={32}
              className="rounded-[0.625rem]"
            />
            {state === "expanded" && (
              <div className="flex flex-col flex-1 text-left">
                <span
                  className={`truncate text-lg font-semibold text-gray-900 tracking-wider ${calSans.className} mb-[-1px]`}
                >
                  Lumen
                </span>
                <span className="truncate text-xs text-gray-600">
                  Ship billing fast
                </span>
              </div>
            )}
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {navigationData.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={pathname === item.url}>
                      <Link href={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <div className="p-1">
          <div className="flex items-center gap-2 px-2 py-1.5 text-left text-sm">
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate text-xs text-muted-foreground">
                v1.0.0
              </span>
            </div>
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
