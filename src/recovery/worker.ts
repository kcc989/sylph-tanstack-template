export interface RecoveryEnvironment {
  SYLPH_RECOVERY_CONTROL: D1Database
  SYLPH_RECOVERY_VERIFY_TOKEN?: string
}

type RecoveryHandler<Environment> = (
  request: Request,
  environment: Environment,
  context: ExecutionContext
) => Response | Promise<Response>

const authenticated = async (provided: string, expected: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(expected),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(expected)
  )
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(provided)
  )
}

export const withRecoveryGate =
  <Environment extends RecoveryEnvironment>(
    handler: RecoveryHandler<Environment>,
    verify?: RecoveryHandler<Environment>
  ): RecoveryHandler<Environment> =>
  async (request, environment, context) => {
    if (verify && new URL(request.url).pathname === "/__sylph/release-verify") {
      const token = environment.SYLPH_RECOVERY_VERIFY_TOKEN
      const provided = request.headers.get("Authorization")
      if (
        request.method !== "GET" ||
        !token ||
        !provided ||
        !(await authenticated(provided, `Bearer ${token}`))
      )
        return new Response("Unauthorized", { status: 401 })
      return verify(request, environment, context)
    }
    const admitted = await environment.SYLPH_RECOVERY_CONTROL.prepare(
      "UPDATE sylph_recovery_gate SET active = active + 1 WHERE id = 1 AND owner IS NULL RETURNING active"
    ).first<{ active: number }>()
    if (!admitted)
      return new Response("Application maintenance is in progress", {
        status: 503,
        headers: { "Retry-After": "30" },
      })
    return runRecoveryWork(environment, context, (tracked) =>
      handler(request, environment, tracked)
    )
  }

const runRecoveryWork = async <A>(
  environment: RecoveryEnvironment,
  context: ExecutionContext,
  work: (tracked: ExecutionContext) => A | Promise<A>
): Promise<A> => {
  const pending: Promise<void>[] = []
  const tracked: ExecutionContext = {
    waitUntil: (promise) => {
      pending.push(
        Promise.resolve(promise).then(
          () => undefined,
          () => undefined
        )
      )
    },
    passThroughOnException: () => {
      throw new Error("Recovery-gated Workers cannot pass through exceptions")
    },
    props: context.props,
    exports: context.exports,
    tracing: context.tracing,
    abort: (reason) => context.abort(reason),
    cache: context.cache,
    access: context.access,
  }
  try {
    return await work(tracked)
  } finally {
    while (pending.length !== 0) await Promise.all(pending.splice(0))
    await environment.SYLPH_RECOVERY_CONTROL.prepare(
      "UPDATE sylph_recovery_gate SET active = active - 1 WHERE id = 1 AND active > 0"
    ).run()
  }
}

type RecoveryQueueHandler<Environment, Body> = (
  batch: MessageBatch<Body>,
  environment: Environment,
  context: ExecutionContext
) => void | Promise<void>

export const withRecoveryQueueGate =
  <Environment extends RecoveryEnvironment, Body>(
    handler: RecoveryQueueHandler<Environment, Body>
  ): RecoveryQueueHandler<Environment, Body> =>
  async (batch, environment, context) => {
    const admitted = await environment.SYLPH_RECOVERY_CONTROL.prepare(
      "UPDATE sylph_recovery_gate SET active = active + 1 WHERE id = 1 AND owner IS NULL RETURNING active"
    ).first<{ active: number }>()
    if (!admitted) {
      batch.retryAll({ delaySeconds: 30 })
      return
    }
    return runRecoveryWork(environment, context, (tracked) =>
      handler(batch, environment, tracked)
    )
  }
