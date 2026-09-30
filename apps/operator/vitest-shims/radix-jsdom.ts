/**
 * jsdom gaps that Radix's popper-backed primitives hit on OPEN.
 *
 * Sibling of resize-observer.ts, mounted the same way (vitest.config.ts
 * setupFiles) and for the same reason: these are real browser APIs that jsdom
 * does not implement, so the crash is in the ENVIRONMENT, not in the component
 * or the assertion.
 *
 * Why this is a shared shim rather than three lines in one test file: every
 * one of these throws only once a Radix menu actually OPENS, so the trap is
 * invisible until someone writes the first test that opens one — and then it
 * presents as a mystifying `candidate?.scrollIntoView is not a function` deep
 * inside node_modules, which reads like a library bug rather than a missing
 * polyfill. Paying it once, centrally, means the next Select/DropdownMenu test
 * anywhere in this app just works.
 *
 * Each guard is `typeof … === 'undefined'`-gated, so if jsdom (or a future
 * happy-dom swap) ever ships a real implementation, the real one wins.
 */

// Radix Select scrolls the active item into view when the listbox opens.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

// Radix's pointer-capture dance during trigger interaction. jsdom defines the
// events but not the capture methods, so a click on a Radix trigger throws.
for (const method of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const) {
  if (typeof Element !== 'undefined' && typeof Element.prototype[method] !== 'function') {
    Object.defineProperty(Element.prototype, method, {
      value:
        method === 'hasPointerCapture'
          ? function hasPointerCapture(): boolean {
              return false;
            }
          : function capture(): void {},
      writable: true,
      configurable: true,
    });
  }
}

// Radix Popper measures the trigger to place the floating element. jsdom
// returns a zero rect, which is fine — but DOMRect itself is sometimes absent
// on older jsdom, and the popper reads `.width` off it unconditionally.
if (typeof Element !== 'undefined' && typeof Element.prototype.getBoundingClientRect !== 'function') {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}
