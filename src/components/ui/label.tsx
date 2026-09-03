import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn("text-xs leading-none font-medium", className)}
      {...props}
    />
  )
}

export { Label }
