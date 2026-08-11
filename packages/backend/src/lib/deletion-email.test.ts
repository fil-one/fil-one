import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('sst', () => ({
  Resource: {
    SendGridApiKey: { value: 'sg-test-key' },
  },
}));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

import { sendDeletionCodeEmail } from './deletion-email.js';

function ok(status = 202) {
  return new Response(null, { status });
}

function fail(status: number, body = 'boom') {
  return new Response(body, { status });
}

const PARAMS = { to: 'user@example.com', orgName: 'Acme Corp', code: '123456' };

describe('sendDeletionCodeEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('logs the code instead of emailing on dev stages (no SendGrid key there)', async () => {
    vi.stubEnv('FILONE_STAGE', 'dev-srdjan');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendDeletionCodeEmail(PARAMS);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('code not emailed'),
      expect.objectContaining({ to: PARAMS.to, code: PARAMS.code }),
    );
    warnSpy.mockRestore();
  });

  it('sends the expected SendGrid payload on production', async () => {
    vi.stubEnv('FILONE_STAGE', 'production');
    mockFetch.mockResolvedValue(ok());

    await sendDeletionCodeEmail(PARAMS);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sg-test-key');

    const payload = JSON.parse(init.body as string);
    expect(payload.personalizations).toEqual([{ to: [{ email: PARAMS.to }] }]);
    expect(payload.from).toEqual({ email: 'no-reply@filone.ai', name: 'Fil One' });
    // The subject must never carry the code: lock-screen previews and mail-server
    // logs would expose a live one.
    expect(payload.subject).toBe('Your Fil One account deletion code');
    expect(payload.subject).not.toContain(PARAMS.code);
    // The code appears in both the plain-text and HTML bodies.
    for (const content of payload.content) {
      expect(content.value).toContain(PARAMS.code);
      expect(content.value).toContain('Acme Corp');
    }
  });

  it('sends from the +staging subaddress on staging', async () => {
    vi.stubEnv('FILONE_STAGE', 'staging');
    mockFetch.mockResolvedValue(ok());

    await sendDeletionCodeEmail(PARAMS);

    const payload = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(payload.from.email).toBe('no-reply+staging@filone.ai');
  });

  it('throws on a non-OK SendGrid response', async () => {
    vi.stubEnv('FILONE_STAGE', 'production');
    mockFetch.mockResolvedValue(fail(500));

    await expect(sendDeletionCodeEmail(PARAMS)).rejects.toThrow('SendGrid send failed (500)');
  });
});
