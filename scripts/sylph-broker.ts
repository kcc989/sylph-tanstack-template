import { Effect, Layer } from "effect"
import * as Cloudflare from "alchemy/Cloudflare"
import { State } from "alchemy/State/State"
import { makeHttpStateStore } from "alchemy/State/HttpStateStore"

export const sylphState = () => {
  const url = process.env.SYLPH_ALCHEMY_STATE_URL
  if (!url) return Cloudflare.state()
  const authToken = process.env.CLOUDFLARE_API_TOKEN ?? ""
  if (
    !url.startsWith("https://") ||
    !/^sylph-cap-[a-f0-9]{64}$/.test(authToken)
  )
    throw new Error(
      "Sylph requires its HTTPS Project deployment broker and a capability token"
    )
  return Layer.effect(
    State,
    makeHttpStateStore({ id: "sylph-project", url, authToken }).pipe(
      Effect.map(Effect.succeed)
    )
  )
}
