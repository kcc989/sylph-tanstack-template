import { createFileRoute } from "@tanstack/react-router"
import { env } from "cloudflare:workers"

import { createRequestAuth } from "@/server/auth"

const handleAuthRequest = (request: Request) =>
  createRequestAuth(request, env).handler(request)

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
    },
  },
})
