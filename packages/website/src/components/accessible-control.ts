/**
 * The shared form primitives render no text of their own, so an accessible name
 * has to arrive as a prop.
 *
 * `id` names a control only when a `<label htmlFor>` points at it, which the
 * platform allows for labelable elements (`input`, `select`, `textarea`,
 * `button`). `aria-labelledby` is not offered: Headless UI sets it from its own
 * `<Label>` context and overwrites whatever a caller passes.
 */
export type AccessibleControlName =
  | {
      id: string;
      'aria-label'?: string;
    }
  | {
      id?: string;
      'aria-label': string;
    };

/**
 * Backstop for the call sites the type cannot see, notably Storybook `args`,
 * which are `Partial<Props>` and so satisfy no required prop.
 */
export function warnIfUnnamedControl(component: string, name: string | undefined) {
  if (import.meta.env.DEV && !name) {
    console.error(`${component} rendered without an accessible name (see AccessibleControlName).`);
  }
}
