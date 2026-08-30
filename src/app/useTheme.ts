import { useLayoutEffect } from "react";
import type { Theme } from "@/types/models";

const DARK_META_COLOR = "#0f172a";
const LIGHT_META_COLOR = "#f8fafc";

function resolveTheme(theme: Theme | undefined): "light" | "dark" {
  // До приезда строки настроек из Dexie theme === undefined, и остаётся
  // тёмным — текущее поведение приложения, не зависящее от системной темы.
  if (theme === undefined) return "dark";
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function applyTheme(resolved: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", resolved);
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", resolved === "light" ? LIGHT_META_COLOR : DARK_META_COLOR);
}

/**
 * Раздел 8.4, часть 1.3: тема ставится на <html> как явный data-theme, даже
 * при settings.theme === "system" (инвариант 33 — источник переключения это
 * matchMedia, а не часы устройства). useLayoutEffect, а не useEffect: атрибут
 * должен стоять до первой отрисовки, иначе экран на мгновение мигнёт тёмным.
 */
export function useTheme(theme: Theme | undefined) {
  useLayoutEffect(() => {
    applyTheme(resolveTheme(theme));

    if (theme !== "system") return;
    if (typeof window.matchMedia !== "function") return;

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme(resolveTheme(theme));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
}
