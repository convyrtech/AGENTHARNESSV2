import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui Switch (new-york).
 * On state uses product interactive accent `--switch-on` (#379cfc).
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent shadow-xs transition-all outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // default is the 24 px minimum target (WCAG 2.5.8, layout-lint target-size)
        "data-[size=default]:h-6 data-[size=default]:w-10 data-[size=sm]:h-3.5 data-[size=sm]:w-6",
        "data-[state=checked]:bg-[var(--switch-on,#379cfc)] data-[state=unchecked]:bg-input",
        "dark:data-[state=unchecked]:bg-input/80",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-white ring-0 transition-transform",
          "group-data-[size=default]/switch:size-5 group-data-[size=sm]/switch:size-3",
          "data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
