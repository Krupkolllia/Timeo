import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { NumberInput } from "@/components/NumberInput";

/** Обёртка с состоянием — как её использует экран дня: value приходит извне. */
function Controlled({ initial = 0, onValue }: { initial?: number; onValue?: (v: number) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

function type(value: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });
}

describe("NumberInput", () => {
  it("accepts a comma as the decimal separator", () => {
    // Русская и польская раскладки iOS дают на цифровой панели запятую. Без
    // нормализации дробное число ввести нечем, а поле молча откатывается.
    const onChange = vi.fn();
    render(<NumberInput value={0} onChange={onChange} />);
    type("8,5");

    expect(onChange).toHaveBeenCalledWith(8.5);
    expect(screen.getByRole("textbox")).toHaveValue("8.5");
  });

  it("does not emit a value for input that is not a number yet", () => {
    // "" и "-" — промежуточные состояния. Раньше они уезжали в расчёт как 0 и
    // NaN и оседали в Dexie, ломая итог периода.
    const onChange = vi.fn();
    render(<NumberInput value={5} onChange={onChange} />);

    type("");
    type("-");
    type("-.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets a negative number be typed one character at a time", () => {
    // Раздел 8: отрицательные суммы разрешены — это способ записать удержание.
    const onValue = vi.fn();
    render(<Controlled initial={0} onValue={onValue} />);

    type("-");
    type("-1");
    type("-1.");
    type("-1.5");

    expect(onValue).toHaveBeenLastCalledWith(-1.5);
  });

  it("lets a decimal be typed through its intermediate '0.' state", () => {
    const onValue = vi.fn();
    render(<Controlled initial={8} onValue={onValue} />);

    type("0");
    type("0.");
    type("0.5");

    expect(onValue).toHaveBeenLastCalledWith(0.5);
    expect(screen.getByRole("textbox")).toHaveValue("0.5");
  });

  it("rejects text that is not a number in progress and keeps the previous text", () => {
    const onChange = vi.fn();
    render(<NumberInput value={12} onChange={onChange} />);

    type("1e5");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("12");

    type("00342");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("12");
  });

  it("resyncs its text when the value changes for an outside reason", () => {
    // Тап по другому типу дня меняет часы и ставку извне — поле обязано
    // показать новое число, а не то, что осталось от прошлого ввода.
    const { rerender } = render(<NumberInput value={8} onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toHaveValue("8");

    rerender(<NumberInput value={12} onChange={() => {}} />);
    expect(screen.getByRole("textbox")).toHaveValue("12");
  });

  it("does not resync while the user's own typing produced the same value", () => {
    // Инвариант 20: показанное в поле не переписывает сохранённое. "1.50" и 1.5
    // — одно число, и перерисовка не должна съедать набранный ноль.
    render(<Controlled initial={0} />);
    type("1.50");
    expect(screen.getByRole("textbox")).toHaveValue("1.50");
  });

  it("normalizes the text on blur", () => {
    render(<Controlled initial={0} />);
    type("1.50");
    fireEvent.blur(screen.getByRole("textbox"));
    expect(screen.getByRole("textbox")).toHaveValue("1.5");
  });

  it("selects its content on focus so a tap replaces the value", () => {
    render(<NumberInput value={8} onChange={() => {}} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    const select = vi.spyOn(input, "select");
    fireEvent.focus(input);
    expect(select).toHaveBeenCalled();
  });

  it("can be disabled", () => {
    render(<NumberInput value={8} onChange={() => {}} disabled />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("uses the numeric keypad when asked", () => {
    render(<NumberInput value={8} onChange={() => {}} inputMode="numeric" />);
    expect(screen.getByRole("textbox")).toHaveAttribute("inputmode", "numeric");
  });
});
