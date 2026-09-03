import { createServerFn } from "@tanstack/react-start"

import { requestSession } from "@/functions/middleware"

export const getSession = createServerFn({ method: "GET" })
  .middleware([requestSession])
  .handler(async ({ context }) => {
    const session = context.session
    if (!session) return null
    return {
      user: {
        name: session.user.name,
        email: session.user.email,
      },
    }
  })
