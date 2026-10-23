import { describe, it, expect } from 'vitest';

import { renderEmailLayout } from './email-layout.ts';
import type { EmailLayoutParams } from './email-layout.ts';

function layout(over: Partial<EmailLayoutParams> = {}): EmailLayoutParams {
  return {
    heading: 'any heading',
    preheader: 'any preheader',
    contentHtml: '<p>any content</p>',
    consoleUrl: 'https://console.example',
    ...over,
  };
}

describe('renderEmailLayout', () => {
  it('loads the logo from the console it is given', () => {
    const html = renderEmailLayout(layout({ consoleUrl: 'https://console.example/any/path' }));

    expect(html).toContain(
      'src="https:&#x2F;&#x2F;console.example&#x2F;static&#x2F;email&#x2F;fil-one-logo.png"',
    );
  });

  it.each([
    ['no console URL', undefined],
    // Not an absolute URL, so there is no origin to load the logo from.
    ['a console URL that does not parse', 'console.example'],
  ])('names Fil One in text instead of an image given %s', (_case, consoleUrl) => {
    const html = renderEmailLayout(layout({ consoleUrl }));

    expect(html).not.toContain('<img');
    expect(html).toContain('>Fil One</span>');
  });

  it.each(['heading', 'preheader', 'footer'] as const)('escapes the %s', (field) => {
    const html = renderEmailLayout(layout({ [field]: 'Acme <script>alert(1)</script>' }));

    expect(html).toContain('Acme &lt;script&gt;alert(1)&lt;&#x2F;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('places the content markup as given', () => {
    const html = renderEmailLayout(layout({ contentHtml: '<p id="any-content">a</p>' }));

    expect(html).toContain('<p id="any-content">a</p>');
  });
});
