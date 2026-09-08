import application from "@tanstack/react-start/server-entry"
import { withRecoveryGate, withRecoveryQueueGate } from "./recovery/worker"
import type { RecoveryQueueNotification } from "./recovery/queue-domain"
import { recoveryProbe } from "./recovery/verification"

import { consumeManagedQueue } from "./managed"
import { managedQueueHandlers } from "./managed-queue-handlers"

import { objectRecoveryRoute } from "./managed-object-routing"
export { ManagedState } from "./managed-object"

const guardedFetch = withRecoveryGate<Cloudflare.Env>(
  (request) => application.fetch(request),
  (request, env) => recoveryProbe(request, env)
)

export default {
  queue: withRecoveryQueueGate<Cloudflare.Env, RecoveryQueueNotification>(
    (batch, environment: Cloudflare.Env) =>
      consumeManagedQueue(batch, environment, managedQueueHandlers)
  ),
  fetch: async (
    request: Request,
    environment: Cloudflare.Env,
    context: ExecutionContext
  ) =>
    (await objectRecoveryRoute(request, environment)) ??
    guardedFetch(request, environment, context),
}
