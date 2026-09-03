import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { betterAuth } from "better-auth"
import { drizzle } from "drizzle-orm/d1"

import * as schema from "@/db/schema"

export const createAuth = (
  database: D1Database,
  baseURL: string,
  secret: string
) =>
  betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(drizzle(database, { schema }), {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
  })

export const createRequestAuth = (request: Request, bindings: Cloudflare.Env) =>
  createAuth(
    bindings.DB,
    new URL(request.url).origin,
    bindings.BETTER_AUTH_SECRET
  )
