declare global {
  namespace Cloudflare {
    interface Env {
      BETTER_AUTH_SECRET: string
      DB: D1Database
      SYLPH_MANAGED_QUEUE_NAMES: string
      SYLPH_RECOVERY_CONTROL: D1Database
      SYLPH_RECOVERY_VERIFY_TOKEN: string
      SYLPH_RECOVERY_OBJECT_TOKEN?: string
      SYLPH_RELEASE_ID: string
      SYLPH_CHECKPOINT: string
      SYLPH_DEPLOYMENT: string
    }
  }
}

export {}
