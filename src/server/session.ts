import { env } from "cloudflare:workers"

import { createRequestAuth } from "@/server/auth"

export const createRequestSession = async (request: Request) => {
  const auth = createRequestAuth(request, env)
  const session = await auth.api.getSession({ headers: request.headers })
  return { auth, session }
}
