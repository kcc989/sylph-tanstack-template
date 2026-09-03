import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authClient } from "@/lib/auth-client"

export const Route = createFileRoute("/sign-in")({
  component: SignInScreen,
})

type Mode = "sign-in" | "sign-up"

function SignInScreen() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>("sign-in")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    const form = new FormData(event.currentTarget)
    const email = String(form.get("email"))
    const password = String(form.get("password"))
    const result =
      mode === "sign-up"
        ? await authClient.signUp.email({
            email,
            password,
            name: String(form.get("name") || email.split("@")[0]),
          })
        : await authClient.signIn.email({ email, password })

    if (result.error) {
      setError(result.error.message ?? "Authentication failed")
      setPending(false)
      return
    }

    await navigate({ to: "/" })
  }

  return (
    <main className="mx-auto grid min-h-svh w-full max-w-sm content-center gap-4 px-5 py-10">
      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "sign-up" ? "Create an account" : "Sign in"}
          </CardTitle>
          <CardDescription>
            Email and password, stored by Better Auth in D1.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={handleSubmit}>
            {mode === "sign-up" ? (
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" autoComplete="name" />
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={
                  mode === "sign-up" ? "new-password" : "current-password"
                }
                minLength={8}
                required
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              {mode === "sign-up" ? "Create account" : "Sign in"}
            </Button>
          </form>
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={() => {
                setMode(mode === "sign-up" ? "sign-in" : "sign-up")
                setError(null)
              }}
            >
              {mode === "sign-up"
                ? "Have an account? Sign in"
                : "New here? Create an account"}
            </button>
            <Link to="/" className="underline underline-offset-4">
              Home
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
