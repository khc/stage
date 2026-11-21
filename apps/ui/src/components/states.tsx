import { Check, CircleAlert, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty as EmptyRoot,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
      <Spinner />
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
    <EmptyRoot>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </EmptyRoot>
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
      className="max-md:size-9"
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
    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <code className="truncate">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function Overline({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>;
}
