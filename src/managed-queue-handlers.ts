import type { ManagedQueueHandler } from "./managed"

export const managedQueueHandlers: Readonly<
  Record<string, ManagedQueueHandler>
> = {}
