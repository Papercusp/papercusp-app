"use client";

/**
 * The shared radiogroup primitive: a roving-tabindex group of `role="radio"`
 * buttons.
 *
 * Native `<input type="radio">` is blocked in app UI by the design-primitive
 * lint, and the roving-tabindex contract (exactly one tab stop, arrows wrap in
 * both axes, Home/End jump to the ends) had been hand-implemented per surface.
 * One implementation means one keyboard contract to get right, and one place a
 * fix lands.
 *
 * `children` is a render prop so a caller can style an option as a dense list
 * row or as a comparison card without the primitive knowing which.
 */

import { useRef } from "react";

export interface RadioGroupOption<T extends string> {
  value: T;
  /** Disabled options stay focusable-skippable and unselectable. */
  disabled?: boolean;
}

export function RadioGroup<T extends string, O extends RadioGroupOption<T>>({
  label,
  value,
  options,
  onChange,
  className,
  optionClassName,
  children,
}: {
  /** The group's accessible name. */
  label: string;
  value: T | null;
  options: readonly O[];
  onChange: (value: T) => void;
  className?: string;
  optionClassName?: string;
  children: (option: O, selected: boolean) => React.ReactNode;
}) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  /*
   * The selected option is the single tab stop. When nothing is selected yet
   * the FIRST option takes it, so the group is always reachable by keyboard.
   */
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const move = (index: number) => {
    const next = options[index];
    if (!next) return;
    onChange(next.value);
    buttonsRef.current[index]?.focus();
  };

  const onKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % options.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + options.length) % options.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = options.length - 1;
    }
    if (nextIndex === null) return;

    event.preventDefault();
    move(nextIndex);
  };

  return (
    <div className={className} role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            type="button"
            role="radio"
            key={option.value}
            aria-checked={selected}
            className={optionClassName}
            data-selected={selected ? "true" : "false"}
            disabled={option.disabled}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            tabIndex={index === tabStopIndex ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {children(option, selected)}
          </button>
        );
      })}
    </div>
  );
}
