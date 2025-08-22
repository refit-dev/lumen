"use client";

import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";

export function SearchButton() {
  const triggerCommandPalette = () => {
    const event = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      ctrlKey: navigator.platform.indexOf("Mac") !== 0, // support Ctrl+K on Windows/Linux
      bubbles: true,
    });
    document.dispatchEvent(event);
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={triggerCommandPalette}
      className="h-10 w-80 justify-start text-sm font-normal text-muted-foreground bg-background/60 border-border/60 shadow-sm hover:bg-accent/50 hover:border-border transition-all duration-200 backdrop-blur-sm"
    >
      <Search className="mr-3 h-4 w-4 text-muted-foreground/70" />
      <span className="flex-1 text-left">Search everything...</span>
      <div className="ml-auto flex items-center gap-1">
        <kbd className="pointer-events-none inline-flex h-6 select-none items-center gap-1 rounded-md border border-border/60 bg-muted/50 px-2 font-mono text-[11px] font-medium text-muted-foreground/80 shadow-sm">
          {navigator.platform.indexOf("Mac") === 0 ? (
            <span className="text-sm">⌘</span>
          ) : (
            <span className="text-xs">Ctrl</span>
          )}
          <span className="text-xs">K</span>
        </kbd>
      </div>
    </Button>
  );
}
