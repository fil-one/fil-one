import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Stage } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('sst', () => sstResourceMock({ SendGridApiKey: { value: 'test-sendgrid-key' } }));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

import { sendInvitationEmail } from './invite-mailer.js';
import type { SendInvitationEmailParams } from './invite-mailer.js';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const SEND_URL = 'https://api.sendgrid.com/v3/mail/send';
const ACCEPT_URL = 'https://app.filone.ai/invite/tok-123';
/** The same URL after HTML escaping — `/` becomes `&#x2F;`, which decodes back. */
const ACCEPT_URL_ESCAPED = 'https:&#x2F;&#x2F;app.filone.ai&#x2F;invite&#x2F;tok-123';
const EXPIRES_AT = '2026-09-01T12:00:00.000Z';
const EXPIRES_AT_READABLE = 'Tue, 01 Sep 2026 12:00:00 GMT';

const ORIGINAL_STAGE = process.env.FILONE_STAGE;

interface SendGridPayload {
  personalizations: Array<{ to: Array<{ email: string }> }>;
  from: { email: string };
  subject: string;
  content: Array<{ type: string; value: string }>;
}

function invitation(over: Partial<SendInvitationEmailParams> = {}): SendInvitationEmailParams {
  return {
    to: 'Invited.Person@Example.com',
    orgName: 'Acme Storage',
    inviterName: 'Ada Lovelace',
    inviterEmail: 'ada@example.com',
    acceptUrl: ACCEPT_URL,
    expiresAt: EXPIRES_AT,
    ...over,
  };
}

function sentPayload(callIndex = 0): SendGridPayload {
  const init = mockFetch.mock.calls[callIndex][1];
  return JSON.parse(init!.body as string) as SendGridPayload;
}

function sentPart(type: string, callIndex = 0): string {
  const part = sentPayload(callIndex).content.find((c) => c.type === type);
  expect(part, `no ${type} part in the message`).toBeDefined();
  return part!.value;
}

function accepted(): Response {
  // SendGrid answers a successful send with 202 and an empty body.
  return new Response('', { status: 202 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendInvitationEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FILONE_STAGE = Stage.Production;
    mockFetch.mockResolvedValue(accepted());
  });

  afterEach(() => {
    if (ORIGINAL_STAGE === undefined) delete process.env.FILONE_STAGE;
    else process.env.FILONE_STAGE = ORIGINAL_STAGE;
  });

  it('posts the message to SendGrid on production and reports it accepted', async () => {
    const sent = await sendInvitationEmail(invitation());

    expect(sent).toBe(true);
    expect(mockFetch.mock.calls).toHaveLength(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(SEND_URL);
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-sendgrid-key',
        'Content-Type': 'application/json',
      },
    });

    const payload = sentPayload();
    expect(payload.from).toEqual({ email: 'no-reply@filone.ai' });
    // The address as the inviter typed it — casing intact, so the recipient
    // sees the address they handed out rather than a normalized lookup key.
    expect(payload.personalizations).toEqual([{ to: [{ email: 'Invited.Person@Example.com' }] }]);
    expect(payload.subject).toContain('Acme Storage');
  });

  it('sends from the +staging sub-address on staging', async () => {
    process.env.FILONE_STAGE = Stage.Staging;

    const sent = await sendInvitationEmail(invitation());

    expect(sent).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toBe(SEND_URL);
    expect(sentPayload().from).toEqual({ email: 'no-reply+staging@filone.ai' });
  });

  it('carries the org, the inviter, the accept URL and the expiry in both parts', async () => {
    await sendInvitationEmail(invitation());

    const text = sentPart('text/plain');
    expect(text).toContain('Acme Storage');
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('ada@example.com');
    expect(text).toContain(ACCEPT_URL);
    expect(text).toContain(EXPIRES_AT_READABLE);

    const html = sentPart('text/html');
    expect(html).toContain('Acme Storage');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.com');
    expect(html).toContain(`href="${ACCEPT_URL_ESCAPED}"`);
    expect(html).toContain(EXPIRES_AT_READABLE);
  });

  it('names the inviter by email when no display name is stored', async () => {
    await sendInvitationEmail(invitation({ inviterName: undefined }));

    expect(sentPart('text/plain')).toContain('ada@example.com invited you');
  });

  it('still sends when the inviter has neither a name nor an email', async () => {
    await sendInvitationEmail(invitation({ inviterName: undefined, inviterEmail: undefined }));

    // An unnamed sender is no reason to withhold the invitation: the org name
    // and the link are what the recipient needs.
    expect(sentPart('text/plain')).toContain('Someone invited you');
    expect(sentPart('text/plain')).toContain(ACCEPT_URL);
  });

  it('escapes HTML-significant characters in the org and inviter names', async () => {
    await sendInvitationEmail(
      invitation({
        orgName: 'Acme <script>alert(1)</script> & Sons',
        inviterName: 'Ada "Lovelace"',
        inviterEmail: undefined,
      }),
    );

    const html = sentPart('text/html');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&amp; Sons');
    expect(html).toContain('Ada &quot;Lovelace&quot;');

    // The plain-text part is not markup, so it carries the values verbatim.
    const text = sentPart('text/plain');
    expect(text).toContain('Acme <script>alert(1)</script> & Sons');
    expect(text).toContain('Ada "Lovelace"');
  });

  it('logs the accept URL and sends nothing on a stage without the secret', async () => {
    process.env.FILONE_STAGE = 'pr-1234';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const sent = await sendInvitationEmail(invitation());

    // The log line is the delivery mechanism here — the e2e suite reads the
    // accept URL out of it, so it must carry the whole invitation.
    expect(sent).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][1]).toMatchObject({
      stage: 'pr-1234',
      to: 'Invited.Person@Example.com',
      orgName: 'Acme Storage',
      acceptUrl: ACCEPT_URL,
      expiresAt: EXPIRES_AT,
    });
  });

  it('returns false on a non-2xx SendGrid response, logging the status and body', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValue(
      new Response('the from address is not a verified sender', {
        status: 403,
      }),
    );

    // The invitation row is already committed, so a rejected send is reported,
    // never thrown — re-inviting is the retry.
    await expect(sendInvitationEmail(invitation())).resolves.toBe(false);

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('403');
    expect(logged).toContain('not a verified sender');
    expect(logged).not.toContain('test-sendgrid-key');
  });

  it('returns false when the fetch itself rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error('socket hang up'));

    await expect(sendInvitationEmail(invitation())).resolves.toBe(false);

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logged).not.toContain('test-sendgrid-key');
  });
});
