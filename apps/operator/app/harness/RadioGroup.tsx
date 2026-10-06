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
  /** Disabled options are skipped by focus navigation and cannot be selected. */
  disabled?: boolean;
}

export function RadioGroup<T extends string, O extends RadioGroupOption<T>>({
  label,
  value,
  options,
  onChange,
  className,
  optionClassName,
  optionStyle,
  children,
}: {
  /** The group's accessible name. */
  label: string;
  value: T | null;
  options: readonly O[];
  onChange: (value: T) => void;
  className?: string;
  optionClassName?: string;
  optionStyle?: (option: O, selected: boolean) => React.CSSProperties;
  children: (option: O, selected: boolean) => React.ReactNode;
}) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  /*
   * The selected option is the single tab stop. When nothing is selected yet
   * the first ENABLED option takes it. An entirely disabled group has none.
   */
  const enabledIndexes = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const tabStopIndex = selectedIndex >= 0 ? selectedIndex : enabledIndexes[0];

  const move = (index: number) => {
    const next = options[index];
    if (!next || next.disabled) return;
    onChange(next.value);
    buttonsRef.current[index]?.focus();
  };

  const onKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const enabledIndex = enabledIndexes.indexOf(index);
    if (enabledIndex < 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = enabledIndexes[(enabledIndex + 1) % enabledIndexes.length];
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = enabledIndexes[(enabledIndex - 1 + enabledIndexes.length) % enabledIndexes.length];
    } else if (event.key === "Home") {
      nextIndex = enabledIndexes[0];
    } else if (event.key === "End") {
      nextIndex = enabledIndexes[enabledIndexes.length - 1];
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
            style={optionStyle?.(option, selected)}
            data-selected={selected ? "true" : "false"}
            disabled={option.disabled}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            tabIndex={index === tabStopIndex ? 0 : -1}
            onClick={() => { if (!option.disabled) onChange(option.value); }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {children(option, selected)}
          </button>
        );
      })}
    </div>
  );
}
