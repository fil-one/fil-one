import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Stage } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock({ SendGridApiKey: { value: 'test-sendgrid-key' } }));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

import { sendDeletionCodeEmail } from './deletion-email.ts';

const ORIGINAL_ENV = { ...process.env };

interface SendGridPayload {
  subject: string;
  content: Array<{ type: string; value: string }>;
}

function sentHtml(): string {
  const payload = JSON.parse(mockFetch.mock.calls[0][1]!.body as string) as SendGridPayload;
  return payload.content.find((c) => c.type === 'text/html')!.value;
}

describe('sendDeletionCodeEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FILONE_STAGE = Stage.Production;
    process.env.WEBSITE_URL = 'https://console.example';
    mockFetch.mockResolvedValue(new Response('', { status: 202 }));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('shows the code and the escaped organization name in the card', async () => {
    await sendDeletionCodeEmail({ to: 'any@example.com', orgName: 'Acme & Sons', code: '482915' });

    const html = sentHtml();
    expect(html).toContain('>482915</div>');
    expect(html).toContain('>Acme &amp; Sons</span>');
  });

  it('keeps the code out of the subject and the inbox preview', async () => {
    // Both surface on a locked screen, where anyone holding the phone reads them.
    await sendDeletionCodeEmail({ to: 'any@example.com', orgName: 'any-org', code: '482915' });

    const payload = JSON.parse(mockFetch.mock.calls[0][1]!.body as string) as SendGridPayload;
    expect(payload.subject).not.toContain('482915');
    const preheader = sentHtml().match(/<div style="display:none;[^"]*">([^<]*)<\/div>/);
    expect(preheader?.[1]).toBe('Use this code to confirm deleting your Fil One account.');
  });

  it('loads the logo from the console', async () => {
    await sendDeletionCodeEmail({ to: 'any@example.com', orgName: 'any-org', code: '482915' });

    expect(sentHtml()).toContain(
      'src="https:&#x2F;&#x2F;console.example&#x2F;static&#x2F;email&#x2F;fil-one-logo.png"',
    );
  });
});
