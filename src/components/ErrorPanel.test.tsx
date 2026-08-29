import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ErrorBoundary, ErrorPanel, RouteErrorPanel } from "@/components/ErrorPanel";
import { ru } from "@/i18n/ru";

function Boom({ error }: { error: unknown }): never {
  throw error;
}

describe("ErrorPanel", () => {
  it("shows the message of an Error", () => {
    render(<ErrorPanel error={new Error("сломалось")} />);
    expect(screen.getByText(ru.error.title)).toBeInTheDocument();
    expect(screen.getByText("сломалось")).toBeInTheDocument();
  });

  it("shows a plain string as-is", () => {
    render(<ErrorPanel error="строка вместо ошибки" />);
    expect(screen.getByText("строка вместо ошибки")).toBeInTheDocument();
  });

  it("unwraps a react-router route error object", () => {
    render(<ErrorPanel error={{ status: 404, statusText: "Not Found" }} />);
    expect(screen.getByText("404 Not Found")).toBeInTheDocument();
  });

  it("survives a route error object with no statusText", () => {
    render(<ErrorPanel error={{ status: 500 }} />);
    expect(screen.getByText("500")).toBeInTheDocument();
  });

  it("falls back to String() for anything else", () => {
    render(<ErrorPanel error={42} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("carries the build version so the installed build is identifiable from a screenshot", () => {
    render(<ErrorPanel error={new Error("x")} />);
    expect(screen.getByText(/^v\d+\.\d+\.\d+/)).toBeInTheDocument();
  });

  it("reloads the page from the button", () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);

    render(<ErrorPanel error={new Error("x")} />);
    fireEvent.click(screen.getByRole("button", { name: ru.error.reload }));
    expect(reload).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe("ErrorBoundary", () => {
  it("renders the panel instead of unmounting the tree (invariant 58)", () => {
    // Пустой экран на телефоне без отладчика — это конец диагностики, поэтому
    // проверяем именно то, что вместо него что-то нарисовано.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom error={new Error("падение внутри дерева")} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(ru.error.title)).toBeInTheDocument();
    expect(screen.getByText("падение внутри дерева")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("renders its children while nothing has thrown", () => {
    render(
      <ErrorBoundary>
        <p>всё хорошо</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("всё хорошо")).toBeInTheDocument();
  });
});

describe("RouteErrorPanel", () => {
  it("renders a thrown route error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const router = createMemoryRouter(
      [{ path: "/", element: <Boom error={new Error("экран упал")} />, errorElement: <RouteErrorPanel /> }],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText("экран упал")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("names the address when there is no error at all", () => {
    // Тот же компонент стоит на маршруте "*", где useRouteError() отдаёт null:
    // панель не должна объяснять поломку словом "null".
    const router = createMemoryRouter([{ path: "*", element: <RouteErrorPanel /> }], {
      initialEntries: ["/nope"],
    });
    render(<RouterProvider router={router} />);

    expect(screen.getByText(new RegExp(ru.error.unknownAddress))).toBeInTheDocument();
  });
});
