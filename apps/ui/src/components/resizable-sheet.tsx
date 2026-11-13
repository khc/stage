import { useState, type ComponentProps, type KeyboardEvent, type PointerEvent } from "react";

import { SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const MIN_WIDTH = 420;
const STORAGE_KEY = "inspector-width";
const KEY_STEP = 24;

const clampWidth = (width: number) =>
  Math.round(Math.min(Math.max(width, MIN_WIDTH), Math.max(MIN_WIDTH, window.innerWidth * 0.9)));

const savedWidth = () => {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return value ? clampWidth(value) : undefined;
  } catch {
    return undefined;
  }
};

const saveWidth = (width: number) => {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Storage can be unavailable; the width then lasts for this session only.
  }
};

const fromPointer = (e: PointerEvent) => clampWidth(window.innerWidth - e.clientX);

// A right-side sheet whose left edge can be dragged (or moved with the arrow keys).
export function ResizableSheetContent({
  className,
  children,
  label,
  ...props
}: ComponentProps<typeof SheetContent> & { label: string }) {
  const [width, setWidth] = useState<number | undefined>(savedWidth);
  const [dragging, setDragging] = useState(false);
  const handle = {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (dragging) setWidth(fromPointer(e));
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      setDragging(false);
      const next = fromPointer(e);
      setWidth(next);
      saveWidth(next);
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const step = e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
      if (!step) return;
      e.preventDefault();
      const current = width ?? e.currentTarget.parentElement!.offsetWidth;
      const next = clampWidth(current + step);
      setWidth(next);
      saveWidth(next);
    },
  };
  return (
    <SheetContent
      className={cn("data-[side=right]:sm:max-w-none", className)}
      style={width ? { width, maxWidth: "none" } : undefined}
      {...props}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label}`}
        tabIndex={0}
        data-dragging={dragging}
        className="hover:bg-primary/40 focus-visible:bg-primary/60 data-[dragging=true]:bg-primary/60 absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize touch-none transition-colors focus-visible:outline-none"
        {...handle}
      />
      {children}
    </SheetContent>
  );
}
