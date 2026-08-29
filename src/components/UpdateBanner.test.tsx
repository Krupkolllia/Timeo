import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UpdateBanner } from "@/components/UpdateBanner";
import { usePwaStore } from "@/store/pwaStore";
import { ru } from "@/i18n/ru";

afterEach(() => {
  usePwaStore.setState({ needsRefresh: false, applyUpdate: () => {} });
});

describe("UpdateBanner", () => {
  it("renders nothing while there is no update", () => {
    const { container } = render(<UpdateBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the update once the service worker reports one", () => {
    // Раздел 12: устаревший сервис-воркер способен запереть телефон на старой
    // сборке, и это единственная кнопка, которая из неё выводит.
    const applyUpdate = vi.fn();
    usePwaStore.setState({ needsRefresh: true, applyUpdate });

    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: ru.app.updateAvailable }));

    expect(applyUpdate).toHaveBeenCalled();
  });
});
