import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Stage } from '@filone/shared';
import { sstResourceMock } from '../test/sst-resource-mock.js';

vi.mock('sst', () => sstResourceMock({ SendGridApiKey: { value: 'test-sendgrid-key' } }));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

import { sendMail } from './mailer.js';

const SEND_URL = 'https://api.sendgrid.com/v3/mail/send';
const ORIGINAL_STAGE = process.env.FILONE_STAGE;

const MESSAGE = {
  to: 'Person@Example.com',
  subject: 'A subject',
  text: 'A body',
  html: '<p>A body</p>',
};

const CONTEXT = { source: 'test-mailer', logFields: { orgId: 'org-1' } };

function accepted() {
  return new Response('', { status: 202 });
}

function payload() {
  return JSON.parse(mockFetch.mock.calls[0]![1]!.body as string) as {
    personalizations: Array<{ to: Array<{ email: string }> }>;
    from: { email: string; name?: string };
    subject: string;
    content: Array<{ type: string; value: string }>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env.FILONE_STAGE = Stage.Production;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_STAGE === undefined) delete process.env.FILONE_STAGE;
  else process.env.FILONE_STAGE = ORIGINAL_STAGE;
});

describe('sendMail', () => {
  it('posts both parts of the message to SendGrid', async () => {
    mockFetch.mockResolvedValue(accepted());

    expect(await sendMail(MESSAGE, CONTEXT)).toStrictEqual({ sent: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe(SEND_URL);
    expect(payload()).toStrictEqual({
      personalizations: [{ to: [{ email: 'Person@Example.com' }] }],
      from: { email: 'no-reply@filone.ai' },
      subject: 'A subject',
      content: [
        { type: 'text/plain', value: 'A body' },
        { type: 'text/html', value: '<p>A body</p>' },
      ],
    });
  });

  it('sub-addresses the sender off production, so an escaped message is recognizable', async () => {
    process.env.FILONE_STAGE = Stage.Staging;
    mockFetch.mockResolvedValue(accepted());

    await sendMail(MESSAGE, CONTEXT);

    expect(payload().from).toStrictEqual({ email: 'no-reply+staging@filone.ai' });
  });

  it('carries a display name when the message asks for one', async () => {
    mockFetch.mockResolvedValue(accepted());

    await sendMail({ ...MESSAGE, fromName: 'Fil One' }, CONTEXT);

    expect(payload().from).toStrictEqual({ email: 'no-reply@filone.ai', name: 'Fil One' });
  });

  it('sends nothing on a stage with no SendGrid credential', async () => {
    process.env.FILONE_STAGE = 'dev-srdjan';

    expect(await sendMail(MESSAGE, CONTEXT)).toStrictEqual({
      sent: false,
      reason: 'stage_sends_no_mail',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports the refusal SendGrid gave, with its body', async () => {
    mockFetch.mockResolvedValue(new Response('sender not verified', { status: 403 }));

    expect(await sendMail(MESSAGE, CONTEXT)).toStrictEqual({
      sent: false,
      reason: 'rejected',
      status: 403,
      body: 'sender not verified',
    });
  });

  it('reports a request that never got an answer', async () => {
    mockFetch.mockRejectedValue(new Error('socket hang up'));

    expect(await sendMail(MESSAGE, CONTEXT)).toStrictEqual({
      sent: false,
      reason: 'request_failed',
    });
  });

  it('gives up rather than holding a route open', async () => {
    // A timeout arrives as an AbortError and is a failed send like any other.
    mockFetch.mockImplementation((_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });

    expect(await sendMail(MESSAGE, CONTEXT)).toStrictEqual({
      sent: false,
      reason: 'request_failed',
    });
  });

  it('never logs the credential it sent with', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 500 }));

    await sendMail(MESSAGE, CONTEXT);

    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('test-sendgrid-key');
  });

  it('logs under the caller’s own prefix, with the fields it named', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 500 }));

    await sendMail(MESSAGE, CONTEXT);

    expect(vi.mocked(console.error).mock.calls[0]).toStrictEqual([
      '[test-mailer] SendGrid rejected the message',
      { status: 500, body: 'nope', orgId: 'org-1' },
    ]);
  });
});
