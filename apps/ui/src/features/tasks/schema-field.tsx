import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FormField } from "@/lib/api";

// One control for a field of a structured agent input.
export function SchemaField({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  const id = `field-${field.key}`;
  const text = typeof value === "string" ? value : "";
  const control =
    field.kind === "boolean" ? (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={value === true}
          onCheckedChange={(checked) => onChange(checked)}
        />
        <Label htmlFor={id}>{field.label}</Label>
      </div>
    ) : field.kind === "enum" ? (
      <Select value={text} onValueChange={(next) => onChange(next ?? "")}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={field.required ? "Choose…" : "Not set"} />
        </SelectTrigger>
        <SelectContent>
          {field.options?.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : field.kind === "json" ? (
      <Textarea
        id={id}
        rows={3}
        placeholder="JSON value"
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    ) : (
      <Input
        id={id}
        type={field.kind === "number" ? "number" : "text"}
        inputMode={field.kind === "number" ? "decimal" : undefined}
        step={field.kind === "number" ? (field.integer ? 1 : "any") : undefined}
        min={field.kind === "number" ? field.min : undefined}
        max={field.kind === "number" ? field.max : undefined}
        autoComplete="off"
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <div className="flex flex-col gap-1.5">
      {field.kind !== "boolean" && (
        <Label htmlFor={id} className="justify-between">
          {field.label}
          <span className="text-xs font-normal text-muted-foreground">
            {field.required ? "Required" : "Optional"}
          </span>
        </Label>
      )}
      {control}
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
    </div>
  );
}
