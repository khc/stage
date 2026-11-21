import { SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// The small pill beside the message box. Every picker there (agent, model) uses it, so they match.
export function PillSelectTrigger({
  className,
  ...props
}: React.ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn(
        "h-8 w-auto max-w-60 gap-1.5 rounded-full border-border/60 bg-muted/50 px-3 text-xs font-medium shadow-none",
        className,
      )}
      {...props}
    />
  );
}
