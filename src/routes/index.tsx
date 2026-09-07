import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getDeployment } from "@/functions/deployment"
import { getSession } from "@/functions/session"
import { authClient } from "@/lib/auth-client"

export const Route = createFileRoute("/")({
  loader: async () => {
    const [deployment, session] = await Promise.all([
      getDeployment(),
      getSession(),
    ])
    return { deployment, session }
  },
  component: HomeScreen,
})

function HomeScreen() {
  const { deployment, session } = Route.useLoaderData()
  const router = useRouter()
  const [signingOut, setSigningOut] = useState(false)

  const handleSignOut = async () => {
    setSigningOut(true)
    await authClient.signOut()
    await router.invalidate()
    setSigningOut(false)
  }

  return (
    <main className="mx-auto grid min-h-svh w-full max-w-xl content-center gap-6 px-5 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Sylph TanStack template</CardTitle>
          <CardDescription>
            TanStack Start, shadcn/ui, Effect, Better Auth, and Alchemy on
            Cloudflare Workers.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {session ? (
            <p>
              Signed in as <strong>{session.user.name}</strong> (
              {session.user.email}).
            </p>
          ) : (
            <p className="text-muted-foreground">
              You are not signed in. Create an account to try Better Auth on D1.
            </p>
          )}
        </CardContent>
        <CardFooter>
          {session ? (
            <Button
              variant="outline"
              disabled={signingOut}
              onClick={handleSignOut}
            >
              Sign out
            </Button>
          ) : (
            <Button nativeButton={false} render={<Link to="/sign-in" />}>
              Sign in
            </Button>
          )}
        </CardFooter>
      </Card>
      <footer
        className="grid gap-1 font-mono text-xs text-muted-foreground"
        data-sylph-checkpoint={deployment.checkpoint}
        data-sylph-deployment={deployment.kind}
      >
        <p>SYLPH_CHECKPOINT={deployment.checkpoint}</p>
        <p>SYLPH_DEPLOYMENT={deployment.kind}</p>
      </footer>
    </main>
  )
}
