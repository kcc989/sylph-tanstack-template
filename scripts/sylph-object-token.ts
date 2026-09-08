export const deriveObjectRecoveryToken = async (recoveryKey: string) => {
  if (recoveryKey.length < 32)
    throw new Error("Object recovery requires the Installation recovery key")
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(recoveryKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("sylph:durable-object-recovery:v1")
  )
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
