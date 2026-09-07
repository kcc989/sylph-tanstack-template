import { Schema } from "effect"

export const RecoveryProbe = Schema.Struct({
  checkpoint: Schema.String,
  deployment: Schema.Literal("production"),
  releaseId: Schema.NonEmptyString,
  databaseReadable: Schema.Literal(true),
  pausedBy: Schema.NullOr(Schema.String),
  secretFingerprints: Schema.Record(Schema.String, Schema.String),
})

export const secretFingerprints = async (
  secrets: Record<string, string>,
  token: string
) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const result: Record<string, string> = {}
  for (const name of Object.keys(secrets).sort()) {
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(JSON.stringify([name, secrets[name]]))
    )
    result[name] = Array.from(new Uint8Array(signature), (value) =>
      value.toString(16).padStart(2, "0")
    ).join("")
  }
  return result
}

export const recoveryProbe = async (request: Request, env: Cloudflare.Env) => {
  if (
    request.method !== "GET" ||
    !env.SYLPH_RECOVERY_VERIFY_TOKEN ||
    request.headers.get("Authorization") !==
      `Bearer ${env.SYLPH_RECOVERY_VERIFY_TOKEN}`
  )
    return new Response("Not found", { status: 404 })
  const names = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
    JSON.parse(request.headers.get("X-Sylph-Secret-Names") ?? "[]")
  )
  const secrets: Record<string, string> = {}
  for (const name of names) {
    const value = Reflect.get(env, name)
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      !Schema.is(Schema.String)(value)
    )
      return new Response("Invalid secret name", { status: 400 })
    secrets[name] = value
  }
  const gate = await env.SYLPH_RECOVERY_CONTROL.prepare(
    "SELECT owner FROM sylph_recovery_gate WHERE id = 1"
  ).first<{ owner: string | null }>()
  if (!gate)
    return new Response("Recovery control unavailable", { status: 503 })
  await env.DB.prepare("SELECT COUNT(*) AS count FROM user").first()
  return Response.json(
    {
      checkpoint: env.SYLPH_CHECKPOINT,
      deployment: env.SYLPH_DEPLOYMENT,
      releaseId: env.SYLPH_RELEASE_ID,
      databaseReadable: true,
      pausedBy: gate.owner,
      secretFingerprints: await secretFingerprints(
        secrets,
        env.SYLPH_RECOVERY_VERIFY_TOKEN
      ),
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
