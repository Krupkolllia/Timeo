import { defineWorkspace } from "vitest/config";

/**
 * Два набора тестов, потому что это два разных рантайма.
 *
 * Приложение живёт в браузере, и его тесты — в jsdom, с посевом из
 * src/test/setup.ts (fake-indexeddb, matchMedia, размонтирование экранов).
 * Воркер (блок 9) живёт на Cloudflare, где нет ни document, ни IndexedDB;
 * гонять его логику в jsdom-окружении фронтенда значило бы проверять её не в
 * том мире, куда она поедет, — и заодно тащить в неё посев, которого на
 * Cloudflare нет.
 *
 * Настройки покрытия остаются одни на оба набора (vite.config.ts): порог у
 * воркера общий с приложением.
 */
export default defineWorkspace([
  {
    extends: "./vite.config.ts",
    test: {
      name: "app",
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  },
  {
    extends: "./vite.config.ts",
    test: {
      name: "workers",
      environment: "node",
      // Ни одного setup-файла: воркер обязан заводиться без посева.
      setupFiles: [],
      include: ["workers/**/*.test.ts"],
    },
  },
]);
