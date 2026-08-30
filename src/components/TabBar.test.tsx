import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TabBar } from "@/components/TabBar";
import { ru } from "@/i18n/ru";

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <TabBar />
    </MemoryRouter>,
  );
}

describe("TabBar", () => {
  it("показывает четыре вкладки", () => {
    renderAt("/");
    expect(screen.getByRole("link", { name: ru.nav.calendar })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ru.nav.period })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ru.nav.settings })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ru.nav.more })).toBeInTheDocument();
  });

  it("активная вкладка помечена aria-current=page", () => {
    renderAt("/settings");
    expect(screen.getByRole("link", { name: ru.nav.settings })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: ru.nav.calendar })).not.toHaveAttribute("aria-current");
  });

  it.each([
    ["/", ru.nav.calendar],
    ["/period", ru.nav.period],
    ["/settings", ru.nav.settings],
    ["/more", ru.nav.more],
  ])("каждая вкладка ведёт на свой адрес (%s)", (path, label) => {
    renderAt(path);
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", path);
  });
});
