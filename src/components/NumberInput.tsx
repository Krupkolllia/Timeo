import { useEffect, useState } from "react";

interface NumberInputProps {
  /** Связь с <label htmlFor>: без неё поле на экране дня доступно только на ощупь. */
  id?: string;
  value: number;
  onChange: (value: number) => void;
  className?: string;
  inputMode?: "decimal" | "numeric";
  disabled?: boolean;
  /**
   * Как показать число в поле. По умолчанию String(value) — ровно то, что
   * лежит в модели. Поле часов передаёт сюда formatHours: длительность,
   * выведенная из времён (раздел 6.1), хранится неокруглённой, и без этого
   * человек видел бы в поле шириной 80px «7.333333333333333».
   *
   * Инвариант 20: показанное округление никогда не записывается обратно
   * вместо исходного значения — onChange отдаёт то, что человек набрал сам,
   * а этот формат работает только на отображение.
   */
  format?: (value: number) => string;
}

// A number in progress: optional single "-", no leading zeros (other than "0"
// itself or "0.5"), at most one ".". Rejects "00342", "--434", "000.33." —
// these are numbers, not free text, so keystrokes that don't match are simply
// ignored rather than accepted and reformatted after the fact.
const IN_PROGRESS_NUMBER = /^-?(0|[1-9]\d*)?(\.\d*)?$/;

// A plain type="number" input round-trips every keystroke through Number() and
// back to a formatted string, so an in-progress "0." or "-" collapses back to
// "0" before the user can finish typing a decimal or a negative number. This
// keeps its own text buffer and only reformats it when the value changes for a
// reason other than the user's own typing (e.g. tapping a different day type).
export function NumberInput({
  id,
  value,
  onChange,
  className,
  inputMode = "decimal",
  disabled,
  format = String,
}: NumberInputProps) {
  const [text, setText] = useState(() => format(value));

  useEffect(() => {
    // Условие остаётся прежним: пока набранный текст РАЗБИРАЕТСЯ в текущее
    // значение, его не трогаем — иначе «8.» схлопывалось бы обратно в «8» на
    // полпути. При формате с потерей точности (часы) Number(text) значению не
    // равен никогда, и setText просто перезаписывает ту же самую строку —
    // React на одинаковом значении состояния не перерисовывает.
    if (Number(text) !== value) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      id={id}
      type="text"
      inputMode={inputMode}
      disabled={disabled}
      className={className}
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        // На русской и польской раскладке iOS десятичная клавиша на цифровой
        // панели — запятая, а не точка. Без этой замены «8,5» не проходит
        // проверку ниже, поле молча откатывается, и единственный способ ввести
        // дробное число выглядит как сломанная клавиатура. Раздел 9: пассивное
        // бездействие без объяснения — тот же запрет, только незаметный.
        const next = e.target.value.replace(",", ".");
        if (!IN_PROGRESS_NUMBER.test(next)) {
          // Rejecting by simply not calling setText leaves this controlled
          // input's real DOM value at whatever the browser just wrote (e.g. a
          // pasted "1,5" or "1e5") — React only reconciles value back to `text`
          // on the next render, and nothing here triggers one since state
          // didn't change. Writing the DOM value back directly closes that gap.
          e.target.value = text;
          return;
        }
        setText(next);

        // "" and "-" are not numbers yet — propagating them as 0 would stomp on
        // a dependent field (e.g. rate recalculated from multiplier) before the
        // user has actually finished typing a new value.
        if (next === "" || next === "-") return;
        const parsed = Number(next);
        if (!Number.isNaN(parsed)) onChange(parsed);
      }}
      onBlur={() => setText(format(value))}
    />
  );
}
