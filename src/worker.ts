import application from "@tanstack/react-start/server-entry"
import { withRecoveryGate } from "./recovery/worker"
import { recoveryProbe } from "./recovery/verification"

export default {
  fetch: withRecoveryGate<Cloudflare.Env>(
    (request) => application.fetch(request),
    (request, env) => recoveryProbe(request, env)
  ),
}
