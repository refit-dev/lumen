import { useFieldContext } from "@/hooks/form";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export function SwitchField({
  label,
  isOptional,
  disabled,
  onChange,
}: {
  label: string;
  isOptional?: boolean;
  disabled?: boolean;
  onChange?: (value: boolean) => void;
}) {
  const field = useFieldContext<boolean>();
  const isError = !field.state.meta.isValid;

  return (
    <div className="mb-4">
      <div className="flex items-center space-x-2 mb-2">
        <Switch
          checked={field.state.value}
          onCheckedChange={(checked) => {
            field.handleChange(checked);
            onChange?.(checked);
          }}
          disabled={disabled}
        />
        <Label className="text-sm">{label}</Label>
        {isOptional && <Badge variant="secondary">Optional</Badge>}
      </div>
      {isError && (
        <p className="text-sm text-red-500">
          {field.state.meta.errors.join(",")}
        </p>
      )}
    </div>
  );
}
