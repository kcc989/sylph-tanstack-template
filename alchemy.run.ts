import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

const Database = Cloudflare.D1.Database("Database", {
  migrations: "migrations",
})

export class Website extends Cloudflare.Website.Vite<Website>()(
  "Website",
  Effect.gen(function* () {
    const database = yield* Database

    return {
      main: "src/worker.ts",
      compatibility: {
        flags: ["nodejs_compat"],
      },
      env: {
        BETTER_AUTH_SECRET: Config.redacted("BETTER_AUTH_SECRET"),
        DB: database,
        SYLPH_CHECKPOINT: Config.string("SYLPH_CHECKPOINT").pipe(
          Config.withDefault("")
        ),
        SYLPH_DEPLOYMENT: Config.string("SYLPH_DEPLOYMENT").pipe(
          Config.withDefault("local")
        ),
      },
    }
  })
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>

const stackName = (project: string | undefined) => {
  const slug = (project ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return slug ? `sylph-${slug}` : "sylph-tanstack-template"
}

export default Alchemy.Stack(
  stackName(process.env.SYLPH_PROJECT),
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Website

    return {
      url: website.url.as<string>(),
    }
  })
)
