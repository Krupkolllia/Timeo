import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8")) as { version: string };

/**
 * Короткий хеш сборки. Semver из package.json меняется только через workflow и
 * при превью-деплоях веток совпадает у разных сборок — хеш меняется всегда,
 * поэтому на экране показываем пару.
 *
 * Прод собирается на стороне Cloudflare (Workers Builds, см. wrangler.jsonc),
 * а не в GitHub Actions, поэтому GITHUB_SHA там недоступен. Порядок:
 * Workers Builds → GitHub Actions (сборка в CI) → локальный git.
 */
function resolveCommitSha(): string {
  const fromEnv = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);

  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    // Сборка без git и без известных переменных окружения — лучше пустая строка,
    // чем падение сборки из-за строки, которая нужна только для отладки.
    return "";
  }
}

const commitSha = resolveCommitSha();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(commitSha),
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
    // Окружение и посев переехали в vitest.workspace.ts: с блока 9 наборов
    // два — экраны в jsdom (до компонентных тестов ни одна их строка не
    // проверялась вовсе; расчётные тесты от окружения не страдают) и воркер
    // в node. Здесь остаётся общее для обоих.
    //
    // Agent worktrees under .claude/worktrees are only git-ignored via the local,
    // unshared .git/info/exclude — Vitest globs the filesystem directly and would
    // otherwise pick up whatever stale branch state happens to be checked out there.
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      // Воркер (блок 9) — тоже наш код, и порог у него общий с приложением:
      // вынести его из include значило бы написать непокрытую логику отправки
      // уведомлений и не заметить этого по числам.
      include: ["src/**/*.{ts,tsx}", "workers/**/*.ts"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "workers/**/*.test.ts",
        "src/test/**",
        // Точка входа: дёргает createRoot и регистрацию service worker — в
        // jsdom это проверяет только то, что моки вызвались.
        "src/main.tsx",
        "src/vite-env.d.ts",
        // Только типы и константы, исполняемого кода нет.
        "src/types/**",
        "src/i18n/**",
        // Экран праздников исключён с блока 5, когда он был заглушкой; сейчас
        // он наполнен и покрыт тестами, и это исключение стоит снять — но это
        // не работа блока 6. DayTypes из списка убран блоком 4, PastPeriods и
        // ExportRestore — блоком 6 по той же причине: экраны написаны.
        "src/pages/Holidays/**",
      ],
      // Ветки — главный порог: это платёжный журнал, и почти каждая ошибка из
      // ревью пряталась именно в невыполненной ветке (закрытый период, запись
      // старого формата, гонка при создании строки).
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
