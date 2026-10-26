import validator from 'validator';

/**
 * The layout product email shares with the console's auth screens: a white card
 * on a zinc-50 ground carrying the Fil One logo, the same surface as `AuthCard`
 * and the accept-invitation page.
 *
 * Mail clients are not browsers. Gmail and Outlook drop `<style>` blocks, CSS
 * variables and `oklch()`, and Outlook lays out only tables, so every rule is an
 * inline style and the structure is nested tables. Clients that drop
 * `box-shadow` or `border-radius` still get the border.
 *
 * Text parameters (`heading`, `preheader`, `footer`) are escaped here. Parameters ending in `Html` are markup the caller built and
 * escaped itself.
 */

/**
 * The console's design tokens (packages/website/src/styles/globals.css) as hex.
 * Each value is the sRGB conversion of the token it is named after. Change one
 * here when its token changes.
 */
export const EMAIL_COLORS = {
  white: '#ffffff',
  zinc50: '#fafafa',
  zinc200: '#e4e4e7',
  zinc500: '#71717b',
  zinc600: '#52525c',
  zinc900: '#18181b',
};

/** Inter where the reader has it, then each platform's own UI font. */
const FONT_STACK =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** For values a reader copies character by character: codes, key ids. */
export const EMAIL_MONO_FONT_STACK = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

/** The console's `--shadow-auth-card`. */
const AUTH_CARD_SHADOW = '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)';

export interface EmailLayoutParams {
  /** The card's heading and the document title. */
  heading: string;
  /** The inbox preview line. Hidden in the opened message. */
  preheader: string;
  /** The card's content, below the heading. */
  contentHtml: string;
  /** A line below the card, for what the reader may safely ignore. */
  footer?: string;
  /**
   * Any URL on the console that serves the logo. A missing or unparseable value
   * renders the name as text, since sending never throws.
   */
  consoleUrl: string | undefined;
}

export function renderEmailLayout(params: EmailLayoutParams): string {
  const esc = validator.escape;
  const heading = esc(params.heading);
  const footer = params.footer
    ? `<tr><td style="padding:20px 8px 0;font-size:12px;line-height:16px;color:${EMAIL_COLORS.zinc500};text-align:center;">${esc(params.footer)}</td></tr>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background-color:${EMAIL_COLORS.zinc50};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(params.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.zinc50};">
<tr><td align="center" style="padding:48px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;font-family:${FONT_STACK};">
<tr><td style="background-color:${EMAIL_COLORS.white};border:1px solid ${EMAIL_COLORS.zinc200};border-radius:12px;padding:32px;box-shadow:${AUTH_CARD_SHADOW};">
${renderLogo(params.consoleUrl)}
<h1 style="margin:32px 0 0;font-size:16px;line-height:24px;font-weight:500;color:${EMAIL_COLORS.zinc900};">${heading}</h1>
${params.contentHtml}
</td></tr>
${footer}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Body copy: `text-sm` in the paragraph colour, as on the accept page. */
export function renderParagraph(contentHtml: string): string {
  return `<p style="margin:12px 0 0;font-size:14px;line-height:20px;color:${EMAIL_COLORS.zinc600};">${contentHtml}</p>`;
}

/** Secondary copy such as an expiry: `text-ui` in the subtle colour. */
export function renderMetaParagraph(contentHtml: string): string {
  return `<p style="margin:16px 0 0;font-size:13px;line-height:19.5px;color:${EMAIL_COLORS.zinc500};">${contentHtml}</p>`;
}

/** A value inside a sentence that leads it, such as an org name: medium weight, never bold. */
export function renderEmphasis(text: string): string {
  return `<span style="font-weight:500;color:${EMAIL_COLORS.zinc900};">${validator.escape(text)}</span>`;
}

export function renderDivider(): string {
  return `<hr style="margin:24px 0;border:0;border-top:1px solid ${EMAIL_COLORS.zinc200};" />`;
}

/**
 * The logo as a PNG (mail clients do not render SVG), served by the console
 * under `/static/`, which the CloudFront rewrite passes through to the bucket.
 */
function renderLogo(consoleUrl: string | undefined): string {
  const logoUrl = getLogoUrl(consoleUrl);
  return logoUrl
    ? `<img src="${validator.escape(logoUrl)}" width="77" height="20" alt="Fil One" style="display:block;border:0;height:20px;width:77px;" />`
    : `<span style="font-size:16px;font-weight:500;color:${EMAIL_COLORS.zinc900};">Fil One</span>`;
}

function getLogoUrl(consoleUrl: string | undefined): string | undefined {
  if (!consoleUrl) return undefined;
  try {
    return new URL('/static/email/fil-one-logo.png', consoleUrl).href;
  } catch {
    return undefined;
  }
}
