import { Schema } from "effect"
import { managedDurableObjectBindings } from "../scripts/sylph-resources"
import {
  RecoveryObjectDispatch,
  RecoveryObjectRegistry,
  RecoveryObjectResponse,
  type RecoveryObjectRequest,
} from "./recovery/object-domain"

interface RecoverableNamespace {
  idFromName(name: string): DurableObjectId
  idFromString(id: string): DurableObjectId
  get(id: DurableObjectId): {
    recovery(request: RecoveryObjectRequest): Promise<RecoveryObjectResponse>
  }
}

const RecoverableNamespaceBinding = Schema.declare<RecoverableNamespace>(
  (value): value is RecoverableNamespace =>
    typeof value === "object" &&
    value !== null &&
    "idFromName" in value &&
    typeof value.idFromName === "function" &&
    "idFromString" in value &&
    typeof value.idFromString === "function" &&
    "get" in value &&
    typeof value.get === "function"
)

const namespace = (environment: Cloudflare.Env, binding: string) =>
  Schema.decodeUnknownSync(RecoverableNamespaceBinding)(
    Reflect.get(environment, binding)
  )

export const requireRegisteredObject = (
  environment: Cloudflare.Env,
  className: string,
  objectId: string,
  declarations = managedDurableObjectBindings
) => {
  const matching = Object.entries(declarations).filter(
    ([, value]) => value.className === className
  )
  const entry = matching[0]
  if (
    matching.length !== 1 ||
    !entry ||
    !entry[1].objectNames.some(
      (name) =>
        namespace(environment, entry[0]).idFromName(name).toString() ===
        objectId
    )
  )
    throw new Error("Durable Object identity is not registered")
}

export const objectRecoveryRoute = async (
  request: Request,
  environment: Cloudflare.Env,
  declarations = managedDurableObjectBindings
): Promise<Response | null> => {
  const path = new URL(request.url).pathname
  if (!["/__sylph/object-registry", "/__sylph/object-recovery"].includes(path))
    return null
  const token = path.endsWith("object-registry")
    ? environment.SYLPH_RECOVERY_VERIFY_TOKEN
    : environment.SYLPH_RECOVERY_OBJECT_TOKEN
  const provided = request.headers.get("Authorization")
  if (!token || !provided) return new Response("Unauthorized", { status: 401 })
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`Bearer ${token}`)
  )
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      expected,
      new TextEncoder().encode(provided)
    ))
  )
    return new Response("Unauthorized", { status: 401 })
  try {
    if (path.endsWith("object-registry") && request.method === "GET") {
      const registry = Schema.decodeUnknownSync(RecoveryObjectRegistry)(
        Object.entries(declarations).map(([bindingName, value]) => ({
          bindingName,
          className: value.className,
          objectNames: value.objectNames,
          objectIds: value.objectNames.map((name) =>
            namespace(environment, bindingName).idFromName(name).toString()
          ),
        }))
      )
      return Response.json(registry, {
        headers: { "Cache-Control": "no-store" },
      })
    }
    if (path.endsWith("object-recovery") && request.method === "POST") {
      const body = await request.text()
      if (new TextEncoder().encode(body).byteLength > 5 * 1024 * 1024)
        return new Response("Snapshot too large", { status: 413 })
      const input = Schema.decodeUnknownSync(RecoveryObjectDispatch)(
        JSON.parse(body)
      )
      const declared = declarations[input.bindingName]
      if (!declared)
        return new Response("Unknown object binding", { status: 400 })
      const binding = namespace(environment, input.bindingName)
      if (
        !declared.objectNames.some(
          (name) =>
            binding.idFromName(name).toString() ===
            input.request.identity.objectId
        )
      )
        return new Response("Object is not registered", { status: 400 })
      const response = await binding
        .get(binding.idFromString(input.request.identity.objectId))
        .recovery(input.request)
      return Response.json(
        Schema.decodeUnknownSync(RecoveryObjectResponse)(response),
        { headers: { "Cache-Control": "no-store" } }
      )
    }
    return new Response("Method not allowed", { status: 405 })
  } catch {
    return new Response("Object recovery failed; retain the writer pause", {
      status: 409,
    })
  }
}
