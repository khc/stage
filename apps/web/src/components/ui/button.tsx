import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-violet-500 text-white shadow-sm hover:bg-violet-400",
        outline:
          "border border-white/10 bg-white/[0.025] text-slate-200 hover:bg-white/[0.07]",
        ghost: "text-slate-400 hover:bg-white/[0.06] hover:text-white",
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
    <button
      className={twMerge(clsx(buttonVariants({ variant, size }), className))}
      {...props}
    />
  );
}
