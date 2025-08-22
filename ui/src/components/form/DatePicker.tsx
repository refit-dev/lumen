import { useFieldContext } from "@/hooks/form";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CalendarIcon, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDateFormatter } from "@/lib/locale-context";

export function DatePicker({
  label,
  disabled,
  readOnly,
}: {
  label: string;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const field = useFieldContext<Date>();
  const isError = field.state.meta.errors.length > 0;
  const dateFormatter = useDateFormatter();

  const handleCopy = () => {
    if (field.state.value) {
      navigator.clipboard.writeText(
        dateFormatter.formatDate(field.state.value, { style: "long" })
      );
    }
  };

  if (readOnly) {
    return (
      <div className="mb-4">
        <Label className="text-sm text-muted-foreground">{label}</Label>
        <div
          className={cn(
            "flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer",
            isError && "text-red-500"
          )}
          onClick={handleCopy}
        >
          <span>
            {field.state.value
              ? dateFormatter.formatDate(field.state.value, { style: "long" })
              : "-"}
          </span>
          <Copy className="h-4 w-4 text-muted-foreground" />
        </div>
        {isError && (
          <p className="text-sm text-red-500">
            {field.state.meta.errors.join(",")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4">
      <Label>{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              isError && "border-red-300 focus-visible:ring-red-300"
            )}
            disabled={disabled}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {field.state.value ? (
              dateFormatter.formatDate(field.state.value, { style: "long" })
            ) : (
              <span>Pick a date</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={field.state.value}
            onSelect={(date: Date | undefined) => {
              if (date) {
                field.handleChange(date);
              }
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
      {isError && (
        <p className="text-sm text-red-500">
          {field.state.meta.errors.join(",")}
        </p>
      )}
    </div>
  );
}
