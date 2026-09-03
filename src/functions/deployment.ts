import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import { Effect } from "effect"

import {
  currentDeployment,
  Deployment,
  encodeDeploymentInfo,
} from "@/server/deployment"

export const getDeployment = createServerFn({ method: "GET" }).handler(
  async () =>
    encodeDeploymentInfo(
      await Effect.runPromise(
        currentDeployment().pipe(Effect.provide(Deployment.layer(env)))
      )
    )
)
