import { Check, CircleAlert, Copy, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="text-muted-foreground flex items-center justify-center gap-2 p-8 text-sm">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: Error | null; retry?: () => void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>
        {error?.message ?? "The request could not be completed."}
        {retry && (
          <Button variant="link" size="sm" className="px-0" onClick={retry}>
            Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      <div className="bg-muted text-muted-foreground rounded-full p-3 [&_svg]:size-5">{icon}</div>
      <h3 className="font-medium">{title}</h3>
      <p className="text-muted-foreground max-w-sm text-sm">{children}</p>
      {action}
    </div>
  );
}

export function CopyButton({ value, label = "Copy ID" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const text = state === "failed" ? "Could not copy" : state === "copied" ? "Copied" : label;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={text}
      aria-label={text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "failed" ? <CircleAlert /> : state === "copied" ? <Check /> : <Copy />}
    </Button>
  );
}

export function IdLine({ value }: { value: string }) {
  return (
    <div className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
      <code className="truncate">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function Overline({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
      {children}
    </p>
  );
}
