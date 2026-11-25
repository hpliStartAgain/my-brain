import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://ting.is-a.dev",
  output: "static",
  trailingSlash: "never",
  build: {
    format: "file",
    concurrency: 4,
  },
  vite: {
    build: {
      chunkSizeWarningLimit: 2500,
    },
  },
})
