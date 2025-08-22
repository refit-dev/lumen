import { useFormContext } from "@/hooks/form";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export function SubmitButtonWithShortcut({ label }: { label: string }) {
  const form = useFormContext();
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(isSubmitting) => (
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {label}
          {/* <kbd className="ml-2 pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[20px] font-medium text-muted-foreground opacity-100">
            {navigator.platform.indexOf("Mac") === 0 ? "⌘" : "⌃"}
          </kbd>
          + */}
          <kbd className="ml-2pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[20px] font-medium text-muted-foreground opacity-100">
            ↵
          </kbd>
        </Button>
      )}
    </form.Subscribe>
  );
}
