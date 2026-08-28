import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8")) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // Registered manually (src/lib/pwa/registerPwaUpdates.ts) so we can show an
      // update banner and re-check on foreground — the plugin's auto-inject has no hook for that.
      injectRegister: false,
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Timeo",
        short_name: "Timeo",
        description: "Учёт смен и расчёт зарплаты",
        start_url: "/",
        display: "standalone",
        background_color: "#0f172a",
        theme_color: "#0f172a",
        orientation: "portrait",
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    setupFiles: ["./src/test/setup.ts"],
    // Agent worktrees under .claude/worktrees are only git-ignored via the local,
    // unshared .git/info/exclude — Vitest globs the filesystem directly and would
    // otherwise pick up whatever stale branch state happens to be checked out there.
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
  },
});
