import { defineConfig } from "vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  build: { rolldownOptions: { external: ["cloudflare:workers"] } },
  resolve: {
    dedupe: ["effect", "react", "react-dom", "@tanstack/react-router"],
    tsconfigPaths: true,
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})
