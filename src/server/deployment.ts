import { Context, Effect, Layer, Schema } from "effect"

export const DeploymentKind = Schema.Literals([
  "local",
  "preview",
  "production",
])
export type DeploymentKind = typeof DeploymentKind.Type

export class DeploymentInfo extends Schema.Class<DeploymentInfo>(
  "app/server/DeploymentInfo"
)({
  kind: DeploymentKind,
  checkpoint: Schema.String,
}) {}

export const encodeDeploymentInfo = Schema.encodeSync(DeploymentInfo)

type DeploymentBindings = Pick<
  Cloudflare.Env,
  "SYLPH_CHECKPOINT" | "SYLPH_DEPLOYMENT"
>

const decodeDeploymentInfo = Schema.decodeUnknownEffect(DeploymentInfo)

export class Deployment extends Context.Service<
  Deployment,
  {
    readonly current: Effect.Effect<DeploymentInfo, Schema.SchemaError>
  }
>()("app/server/Deployment") {
  static readonly layer = (bindings: DeploymentBindings) =>
    Layer.succeed(
      Deployment,
      Deployment.of({
        current: decodeDeploymentInfo({
          kind: bindings.SYLPH_DEPLOYMENT || "local",
          checkpoint: bindings.SYLPH_CHECKPOINT,
        }),
      })
    )
}

export const currentDeployment = Effect.fn("currentDeployment")(function* () {
  const deployment = yield* Deployment
  return yield* deployment.current
})
