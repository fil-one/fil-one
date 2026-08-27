import type { Breadcrumb, ErrorEvent } from '@sentry/react';
import type { PlausibleRequestPayload } from '@plausible-analytics/tracker';

/**
 * Keep the invitation token out of every URL this app reports.
 *
 * Two reporters capture URLs on their own initiative, and both are covered
 * here: the error reporter, through the hooks it takes; the analytics tracker,
 * through the transform it applies to each event.
 *
 * The accept page strips the fragment as its first act, and `history
 * .replaceState` is itself instrumented: the navigation breadcrumb it leaves
 * records the URL it navigated *from*, which is the one carrying the token. So
 * stripping early is necessary and not sufficient — anything that reads a URL
 * before or during that strip has to be scrubbed too, and the tracker's first
 * pageview is captured when its module is evaluated, earlier than any route
 * code runs at all.
 *
 * Redacting the value rather than dropping the fragment, so a report still shows
 * that somebody was on an accept link when whatever it is went wrong.
 */
const TOKEN_PARAM = /(^|&)(token=)[^&]*/g;

export function scrubInviteToken(url: string): string {
  const hashAt = url.indexOf('#');
  if (hashAt === -1) return url;

  const fragment = url.slice(hashAt + 1);
  if (!/(^|&)token=/.test(fragment)) return url;

  return `${url.slice(0, hashAt)}#${fragment.replace(TOKEN_PARAM, '$1$2REDACTED')}`;
}

/** Scrub every URL-shaped value on a breadcrumb's data bag. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const data = breadcrumb.data;
  if (!data) return breadcrumb;

  const scrubbed: Record<string, unknown> = { ...data };
  for (const key of ['from', 'to', 'url']) {
    const value = scrubbed[key];
    if (typeof value === 'string') scrubbed[key] = scrubInviteToken(value);
  }
  return { ...breadcrumb, data: scrubbed };
}

/**
 * Scrub the URL an event was raised at, and the breadcrumbs already attached to
 * it — those were collected before `beforeBreadcrumb` could have been asked
 * about the ones the SDK adds internally.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const url = event.request?.url;
  const breadcrumbs = event.breadcrumbs;

  return {
    ...event,
    ...(url ? { request: { ...event.request, url: scrubInviteToken(url) } } : {}),
    ...(breadcrumbs ? { breadcrumbs: breadcrumbs.map(scrubBreadcrumb) } : {}),
  };
}

/**
 * Redact the token out of an analytics event before it is sent.
 *
 * `u` is the URL the event is about and `r` the referrer, and either can be an
 * accept link: the pageview after the strip names the pre-strip URL as where it
 * came from.
 */
export function scrubTrackedPayload(payload: PlausibleRequestPayload): PlausibleRequestPayload {
  return {
    ...payload,
    u: scrubInviteToken(payload.u),
    ...(typeof payload.r === 'string' ? { r: scrubInviteToken(payload.r) } : {}),
  };
}
