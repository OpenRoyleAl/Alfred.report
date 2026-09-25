import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-sans text-sm font-medium transition-[opacity,transform,background-color,color] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary: "bg-ink text-paper hover:opacity-90",
        ghost: "bg-transparent text-ink hover:bg-paper-2",
        outline: "bg-transparent text-ink shadow-[0_0_0_1px_var(--color-rule-strong)] hover:bg-paper-2",
        forest: "bg-forest text-forest-fg hover:opacity-90",
      },
      size: {
        sm: "h-9 rounded-sm px-3",
        md: "h-11 rounded-md px-4",
      },
    },
    defaultVariants: { variant: "primary", size: "sm" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
