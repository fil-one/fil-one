import { test as base, expect, type Page } from '@playwright/test';

// Auth0 only accepts callbacks at BASE_URL, so the browser stays on that origin
// while E2E_ORIGIN_REWRITE names the dev server that actually answers.
const baseURL = process.env.BASE_URL!;
const rewriteTo = process.env.E2E_ORIGIN_REWRITE;

/** Where a request for `url` really goes: the rewritten origin, when one is set. */
export function realUrl(url: string): string {
  return rewriteTo && url.startsWith(baseURL) ? rewriteTo + url.slice(baseURL.length) : url;
}

export const test = base.extend({
  context: async ({ context }, use) => {
    if (rewriteTo) {
      await context.route(`${baseURL}/**`, async (route) => {
        try {
          const url = realUrl(route.request().url());
          await route.fulfill({ response: await route.fetch({ url, maxRedirects: 0 }) });
        } catch {
          // The page closed with the request in flight.
          await route.abort().catch(() => {});
        }
      });
      // Vite's HMR socket, held open and silent so it never reaches BASE_URL.
      await context.routeWebSocket(`${baseURL.replace(/^http/, 'ws')}/**`, () => {});
    }
    await use(context);
  },
});

export { expect };
export type { Page } from '@playwright/test';

/** `/api` calls from the test, with the session's cookies and CSRF header. */
export async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  data?: unknown,
) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'hs_csrf_token')?.value ?? '';
  return page.request.fetch(realUrl(new URL(path, baseURL).href), {
    method,
    data,
    headers: { 'X-CSRF-Token': csrf },
  });
}
