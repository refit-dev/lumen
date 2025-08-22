"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

// Define navigation items
const navigationItems = [
  {
    title: ["Dashboard"],
    href: "/dashboard",
  },
  {
    title: ["Subscriptions"],
    href: "/subscriptions",
  },
  {
    title: ["Subscriptions", "Create Subscription"],
    href: "/subscriptions/create",
  },
  {
    title: ["Payments"],
    href: "/payments",
  },
  {
    title: ["Plans"],
    href: "/plans",
  },
  {
    title: ["Plans", "Create Plan"],
    href: "/plans/create",
  },
  {
    title: ["Pricing Table"],
    href: "/pricingtable",
  },
  {
    title: ["Customers"],
    href: "/customers",
  },
  {
    title: ["Customers", "Create Customer"],
    href: "/customers/create",
  },
  {
    title: ["Invoices"],
    href: "/invoices",
  },
  {
    title: ["Invoices", "Create Invoice"],
    href: "/invoices/create",
  },
  {
    title: ["Events"],
    href: "/events",
  },
  {
    title: ["Developer", "API Keys"],
    href: "/developer/apikeys",
  },
  {
    title: ["Developer", "Payment Provider"],
    href: "/developer/paymentprovider",
    keywords: "stripe dodo payment provider configure setup",
  },
  {
    title: ["Merchant Settings"],
    href: "/merchant",
  },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // Set up keyboard shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const runCommand = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search for a page..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup>
          {navigationItems.map((item) => (
            <CommandItem
              key={item.href}
              value={`${item.title.join(" ")} ${item.keywords || ""}`}
              onSelect={() => runCommand(item.href)}
              className="flex items-center justify-between"
            >
              <div className="flex items-center">
                {item.title.map((part, index) => (
                  <span key={index} className="flex items-center">
                    {part}
                    {index < item.title.length - 1 && (
                      <ChevronRight className="h-4 w-4 text-muted-foreground mx-1" />
                    )}
                  </span>
                ))}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
