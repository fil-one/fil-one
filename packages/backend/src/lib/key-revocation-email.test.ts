import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { S3Region, Stage } from '@filone/shared';
import type { AccessKeySummary } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.ts';

vi.mock('sst', () => sstResourceMock({ SendGridApiKey: { value: 'test-sendgrid-key' } }));

vi.mock('./user-profile.ts', () => ({
  readUserProfile: vi.fn(async () => ({ email: 'member@example.com' })),
}));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

import { sendKeyRevocationEmail } from './key-revocation-email.ts';

const ORIGINAL_ENV = { ...process.env };

function key(over: Partial<AccessKeySummary> = {}): AccessKeySummary {
  return {
    id: 'any-key-id',
    keyName: 'any-key',
    accessKeyIdSuffix: 'AB12',
    region: S3Region.EuWest1,
    createdAt: '2026-09-01T12:00:00.000Z',
    reason: 'exceeds_role',
    excess: [],
    ...over,
  };
}

function sentHtml(): string {
  const payload = JSON.parse(mockFetch.mock.calls[0][1]!.body as string) as {
    content: Array<{ type: string; value: string }>;
  };
  return payload.content.find((c) => c.type === 'text/html')!.value;
}

async function sendFor(keys: AccessKeySummary[]): Promise<void> {
  await sendKeyRevocationEmail({
    userId: 'any-user',
    orgName: 'any-org',
    keys,
    cause: { kind: 'removed' },
    changedBy: 'any-admin@example.com',
  });
}

describe('sendKeyRevocationEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FILONE_STAGE = Stage.Production;
    process.env.WEBSITE_URL = 'https://console.example';
    mockFetch.mockResolvedValue(new Response('', { status: 202 }));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('lists each revoked key with its id suffix, region and creation date', async () => {
    await sendFor([
      key({ keyName: 'backup-writer' }),
      key({ keyName: 'ci-reader', accessKeyIdSuffix: 'CD34' }),
    ]);

    const html = sentHtml();
    expect(html).toContain('backup-writer <span');
    expect(html).toContain('…AB12</span>');
    expect(html).toContain('ci-reader <span');
    expect(html).toContain('…CD34</span>');
    expect(html).toContain(
      'Europe (France) eu-west-1 · <span style="white-space:nowrap;">created 2026-09-01</span>',
    );
  });

  it('escapes a key name', async () => {
    await sendFor([key({ keyName: '<img src=x onerror=alert(1)>' })]);

    expect(sentHtml()).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it.each([
    ['one key', 1, 'Your access key was revoked'],
    ['several keys', 2, 'Your access keys were revoked'],
  ])('heads the card for %s', async (_case, count, heading) => {
    await sendFor(Array.from({ length: count }, () => key()));

    expect(sentHtml()).toContain(`>${heading}</h1>`);
  });

  it('loads the logo from the console', async () => {
    await sendFor([key()]);

    expect(sentHtml()).toContain(
      'src="https:&#x2F;&#x2F;console.example&#x2F;static&#x2F;email&#x2F;fil-one-logo.png"',
    );
  });
});
