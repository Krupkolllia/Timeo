import { useEffect, useState } from "react";

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  className?: string;
  inputMode?: "decimal" | "numeric";
  disabled?: boolean;
}

// A plain type="number" input round-trips every keystroke through Number() and
// back to a formatted string, so an in-progress "0." or "-" collapses back to
// "0" before the user can finish typing a decimal or a negative number. This
// keeps its own text buffer and only reformats it when the value changes for a
// reason other than the user's own typing (e.g. tapping a different day type).
export function NumberInput({ value, onChange, className, inputMode = "decimal", disabled }: NumberInputProps) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="text"
      inputMode={inputMode}
      disabled={disabled}
      className={className}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() === "") {
          onChange(0);
          return;
        }
        const parsed = Number(next);
        if (!Number.isNaN(parsed)) onChange(parsed);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}
