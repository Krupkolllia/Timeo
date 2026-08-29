import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Каждый тест рендерит экраны заново: без размонтирования предыдущий остаётся
// в document, и queryBy* находит элементы прошлого теста.
afterEach(() => {
  cleanup();
});
