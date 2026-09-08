import { requireRegisteredObject } from "./managed-object-routing"
import { DurableObject } from "cloudflare:workers"
import { Schema } from "effect"
import {
  recoverDurableObject,
  withRecoveryObjectGate,
} from "./recovery/object-worker"
import { RecoveryObjectRequest } from "./recovery/object-domain"

export class ManagedState extends DurableObject<Cloudflare.Env> {
  protected recoveryClassName = "ManagedState"
  async get(key: string) {
    requireRegisteredObject(
      this.env,
      this.recoveryClassName,
      this.ctx.id.toString()
    )
    return withRecoveryObjectGate(this.env.SYLPH_RECOVERY_CONTROL, async () =>
      this.ctx.storage.get<Schema.Json>(key)
    )
  }
  async put(key: string, value: Schema.Json) {
    requireRegisteredObject(
      this.env,
      this.recoveryClassName,
      this.ctx.id.toString()
    )
    return withRecoveryObjectGate(this.env.SYLPH_RECOVERY_CONTROL, async () =>
      this.ctx.storage.put(
        Schema.decodeUnknownSync(Schema.NonEmptyString)(key),
        Schema.decodeUnknownSync(Schema.Json)(value)
      )
    )
  }
  async delete(key: string) {
    requireRegisteredObject(
      this.env,
      this.recoveryClassName,
      this.ctx.id.toString()
    )
    return withRecoveryObjectGate(this.env.SYLPH_RECOVERY_CONTROL, async () =>
      this.ctx.storage.delete(key)
    )
  }
  async recovery(input: RecoveryObjectRequest) {
    requireRegisteredObject(
      this.env,
      this.recoveryClassName,
      this.ctx.id.toString()
    )
    const request = Schema.decodeUnknownSync(RecoveryObjectRequest)(input)
    return recoverDurableObject(
      this.ctx,
      this.env.SYLPH_RECOVERY_CONTROL,
      {
        namespaceId: request.identity.namespaceId,
        objectId: this.ctx.id.toString(),
      },
      request,
      async () => {}
    )
  }
}
