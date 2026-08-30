import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Каждый тест рендерит экраны заново: без размонтирования предыдущий остаётся
// в document, и queryBy* находит элементы прошлого теста.
afterEach(() => {
  cleanup();
});

// jsdom не грузит index.html — useTheme читает и правит существующий
// <meta name="theme-color">, а не создаёт его.
if (!document.querySelector('meta[name="theme-color"]')) {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", "#0f172a");
  document.head.appendChild(meta);
}

// jsdom не реализует matchMedia. useTheme (блок 7) читает его, чтобы решить
// тему при settings.theme === "system" — без заглушки падал бы каждый тест,
// который рендерит App или страницы с этим хуком, а не только тест самого хука.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}
