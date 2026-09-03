declare global {
  namespace Cloudflare {
    interface Env {
      BETTER_AUTH_SECRET: string
      DB: D1Database
      SYLPH_CHECKPOINT: string
      SYLPH_DEPLOYMENT: string
    }
  }
}

export {}
