import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-violet-500 text-white shadow-sm hover:bg-violet-400",
        outline:
          "border border-[var(--button-border)] bg-[var(--button-bg)] text-[var(--button-text)] hover:bg-[var(--button-hover)]",
        ghost:
          "text-[var(--button-muted)] hover:bg-[var(--button-hover)] hover:text-[var(--button-text)]",
      },
      size: { default: "h-10 px-4", sm: "h-8 px-3 text-xs", icon: "size-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button className={twMerge(clsx(buttonVariants({ variant, size }), className))} {...props} />
  );
}
