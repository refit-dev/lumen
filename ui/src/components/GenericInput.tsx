import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function GenericInput({
  label,
  name,
  placeholder,
  type,
  value,
  onChange,
}: {
  label: string;
  name: string;
  placeholder: string;
  type: string;
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="grid w-full max-w-sm items-center gap-1.5 mb-4">
      <Label htmlFor={name}>{label}</Label>
      <Input
        type={type}
        id={name}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}
