import type { ComponentProps, ReactNode } from "react";

import { IdLine, Overline } from "@/components/states";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export const paneBody = "flex flex-col gap-4 overflow-y-auto px-6 py-5";

// Header shared by the task and job panes: eyebrow bar, icon tile, title, id and an action row.
export function PaneHeader({
  eyebrow,
  icon,
  title,
  id,
  children,
}: {
  eyebrow: string;
  icon: ReactNode;
  title: ReactNode;
  id: string;
  children: ReactNode;
}) {
  return (
    <header>
      <div className="flex h-14 items-center border-b bg-muted/40 px-6">
        <Overline>{eyebrow}</Overline>
      </div>
      <div className="flex items-center gap-4 px-6 pt-5 pb-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15 [&_svg]:size-6">
          {icon}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <SheetTitle className="line-clamp-2 text-lg font-semibold">{title}</SheetTitle>
          <IdLine value={id} />
        </div>
      </div>
      <div className="mx-6 border-t" />
      <SheetDescription
        render={<div />}
        className="flex flex-wrap items-center gap-2 px-6 py-4 text-foreground"
      >
        {children}
      </SheetDescription>
    </header>
  );
}

export const PaneTabsList = ({ className, ...props }: ComponentProps<typeof TabsList>) => (
  <TabsList
    variant="line"
    className={cn("h-11 w-full justify-start gap-4 rounded-none border-b p-0 px-6", className)}
    {...props}
  />
);

export const PaneTab = ({ className, ...props }: ComponentProps<typeof TabsTrigger>) => (
  <TabsTrigger
    className={cn(
      "h-full flex-none px-1 pb-1 after:bg-primary group-data-horizontal/tabs:after:bottom-[-1px] data-active:text-primary",
      className,
    )}
    {...props}
  />
);

export const TabCount = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary">
    {children}
  </span>
);
