import { RecoveryProbe } from "../src/recovery/verification"
import { Schema } from "effect"
import { RecoverySettingsResponse } from "../src/recovery/domain"
import {
  RecoveryObjectRegistry,
  RecoveryObjectResponse,
  type RecoveryObjectRequest,
} from "../src/recovery/object-domain"

export const inspectManagedObjects = async (
  configuration: {
    apiBaseUrl: string
    apiToken: string
    objectToken?: () => Promise<string>
    expectedCheckpoints?: readonly string[]
  },
  workerName: string,
  declarations: readonly {
    bindingName: string
    className: string
    objectNames: readonly string[]
  }[],
  workerURL: string | undefined,
  token: string,
  request: typeof fetch = fetch
) => {
  const transport = async (
    input: RecoveryObjectRequest
  ): Promise<RecoveryObjectResponse> => {
    const registration = registrations.find(
      (item) =>
        item.namespaceId === input.identity.namespaceId &&
        item.objectIds.includes(input.identity.objectId)
    )
    if (!registration || !workerURL)
      throw new Error("Object recovery identity is not registered")
    if (!configuration.objectToken)
      throw new Error("Object mutation capability is unavailable")
    const objectToken = await configuration.objectToken()
    const response = await request(
      new URL("/__sylph/object-recovery", workerURL),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${objectToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bindingName: registration.bindingName,
          request: input,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      }
    )
    if (!response.ok)
      throw new Error("Managed object recovery failed; retain writer pause")
    return Schema.decodeUnknownSync(RecoveryObjectResponse)(
      await response.json()
    )
  }
  const registrations: {
    bindingName: string
    namespaceId: string
    objectIds: readonly string[]
  }[] = []
  if (!declarations.length) return { registrations, identities: [], transport }
  if (!workerURL || !token)
    throw new Error(
      "Managed object recovery requires the current Worker URL and verification token"
    )
  const settingsResponse = await request(
    `${configuration.apiBaseUrl}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
    {
      headers: { Authorization: `Bearer ${configuration.apiToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }
  )
  if (!settingsResponse.ok)
    throw new Error("Cannot inspect managed object namespaces")
  const settings = Schema.decodeUnknownSync(RecoverySettingsResponse)(
    await settingsResponse.json()
  )
  if (!settings.success)
    throw new Error("Provider could not verify object namespaces")
  if (configuration.expectedCheckpoints?.length) {
    const response = await request(
      new URL("/__sylph/release-verify", workerURL),
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }
    )
    if (!response.ok)
      throw new Error("Owned object Worker identity probe failed")
    const probe = Schema.decodeUnknownSync(RecoveryProbe)(await response.json())
    if (!configuration.expectedCheckpoints.includes(probe.checkpoint))
      throw new Error("Object Worker checkpoint is outside this release")
  }
  const registryResponse = await request(
    new URL("/__sylph/object-registry", workerURL),
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }
  )
  if (!registryResponse.ok)
    throw new Error("Cannot inspect the registered object IDs")
  const registry = Schema.decodeUnknownSync(RecoveryObjectRegistry)(
    await registryResponse.json()
  )
  if (registry.length !== declarations.length)
    throw new Error(
      "Deployed object registry differs from the reviewed declarations"
    )
  for (const declaration of declarations) {
    const bindings = settings.result.bindings.filter(
      (item) =>
        item.name === declaration.bindingName &&
        item.type === "durable_object_namespace"
    )
    const namespaceId = bindings[0]?.namespace_id ?? bindings[0]?.id
    const matched = registry.filter(
      (item) => item.bindingName === declaration.bindingName
    )
    const objects = matched[0]?.objectIds
    if (
      bindings.length !== 1 ||
      !namespaceId ||
      matched.length !== 1 ||
      matched[0]?.className !== declaration.className ||
      JSON.stringify(matched[0]?.objectNames) !==
        JSON.stringify(declaration.objectNames) ||
      !objects ||
      objects.length !== declaration.objectNames.length ||
      new Set(objects).size !== objects.length
    )
      throw new Error(
        "Declared object namespace or registry is missing or ambiguous"
      )
    registrations.push({
      bindingName: declaration.bindingName,
      namespaceId,
      objectIds: objects,
    })
  }
  return {
    registrations,
    identities: registrations.flatMap((item) =>
      item.objectIds.map((objectId) => ({
        namespaceId: item.namespaceId,
        objectId,
      }))
    ),
    transport,
  }
}
