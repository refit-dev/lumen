import { useFieldContext } from "@/hooks/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function TextField({
  label,
  isOptional,
  autoFocus,
  disabled,
  readOnly,
  onChange,
}: {
  label: string;
  isOptional?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}) {
  const field = useFieldContext<string>();
  const isError = !field.state.meta.isValid;

  const handleCopy = () => {
    navigator.clipboard.writeText(field.state.value);
  };

  if (readOnly) {
    return (
      <div className="mb-4">
        <div className="flex items-center space-x-2 mb-1">
          <Label className="text-sm text-muted-foreground">{label}</Label>
          {isOptional && <Badge variant="secondary">Optional</Badge>}
        </div>
        <div
          className={cn(
            "flex items-center justify-between p-2 rounded-md hover:bg-muted/50 cursor-pointer",
            isError && "text-red-500"
          )}
          onClick={handleCopy}
        >
          <span>{field.state.value || "-"}</span>
          <Copy className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="flex items-center space-x-2 mb-1">
        <Label>{label}</Label>
        {isOptional && <Badge variant="secondary">Optional</Badge>}
      </div>
      <Input
        value={field.state.value}
        onChange={(e) => {
          field.handleChange(e.target.value);
          onChange?.(e.target.value);
        }}
        className={isError ? "border-red-300 focus-visible:ring-red-300" : ""}
        autoFocus={autoFocus}
        disabled={disabled}
      />
      {isError && (
        <p className="text-sm text-red-500">
          {field.state.meta.errors.join(",")}
        </p>
      )}
    </div>
  );
}
