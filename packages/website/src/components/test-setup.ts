import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';

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
