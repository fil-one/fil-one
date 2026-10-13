import * as matchers from '@testing-library/jest-dom/matchers';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';

// jest-dom's own vitest typings declare `Assertion<T>` with the single type
// parameter of vitest 4, which cannot merge into vitest 5's `Matchers<R, T>`.
declare module 'vitest' {
  // The type parameters must match vitest's own declaration for the merge to
  // work. jest-dom takes the assertion's return type as its second parameter.
  // oxlint-disable-next-line typescript/no-explicit-any
  interface Matchers<R, T> extends TestingLibraryMatchers<any, R> {}
}

expect.extend(matchers);

/**
 * jsdom implements no `ResizeObserver`, and Headless UI's anchored floating
 * elements — the `anchor` prop on `MenuItems`, used by `RowActionsMenu` —
 * observe their trigger to reposition. The absence surfaces as an unhandled
 * error rather than a failing assertion: the tests pass and the run still exits
 * non-zero.
 *
 * A no-op is the honest stand-in. Nothing under test asserts on repositioning,
 * and jsdom reports a zero-sized box for every element anyway, so a real
 * implementation would have nothing to report.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
