import { createMiddleware } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"

import { createRequestSession } from "@/server/session"

export const requestSession = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const request = getRequest()
    const { auth, session } = await createRequestSession(request)
    return next({ context: { request, auth, session } })
  }
)

export const authenticated = createMiddleware({ type: "function" })
  .middleware([requestSession])
  .server(async ({ context, next }) => {
    if (!context.session) {
      throw new Response("Sign in to continue", { status: 401 })
    }
    return next({
      context: { session: context.session, user: context.session.user },
    })
  })
