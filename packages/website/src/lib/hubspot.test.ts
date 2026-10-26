import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitContactSalesForm, submitSupportForm } from './hubspot.js';

// ---------------------------------------------------------------------------
// Setup — mock fetch to prevent real API calls
// ---------------------------------------------------------------------------

const PORTAL_ID = '51191454';
const SUPPORT_FORM_ID = '44da45a4-b99b-4886-988a-70e27308322d';
const CONTACT_SALES_FORM_ID = 'bae0c5ed-9724-4831-a285-a0b06fa56298';

function hubspotUrl(formId: string) {
  return `https://api.hsforms.com/submissions/v3/integration/submit/${PORTAL_ID}/${formId}`;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', { location: { href: 'https://app.fil.one/support' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// submitSupportForm
// ---------------------------------------------------------------------------

describe('submitSupportForm', () => {
  it('sends correct payload with all fields', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitSupportForm({
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme Inc',
      email: 'jane@acme.com',
      categories: ['PRODUCT_ISSUE'],
      message: 'Help needed',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(hubspotUrl(SUPPORT_FORM_ID), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: [
          { objectTypeId: '0-1', name: 'firstname', value: 'Jane' },
          { objectTypeId: '0-1', name: 'lastname', value: 'Doe' },
          { objectTypeId: '0-1', name: 'company', value: 'Acme Inc' },
          { objectTypeId: '0-1', name: 'email', value: 'jane@acme.com' },
          { objectTypeId: '0-5', name: 'hs_ticket_category', value: 'PRODUCT_ISSUE' },
          { objectTypeId: '0-5', name: 'content', value: 'Help needed' },
        ],
        context: {
          pageUri: 'https://app.fil.one/support',
          pageName: 'Support',
        },
      }),
    });
  });

  it('joins multiple categories with semicolons', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitSupportForm({
      firstName: 'John',
      lastName: 'Smith',
      company: 'Test Corp',
      email: 'john@test.com',
      categories: ['PRODUCT_ISSUE', 'BILLING_ISSUE', 'FEATURE_REQUEST'],
      message: 'Multiple issues',
    });

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);
    const categoryField = body.fields.find(
      (f: { name: string }) => f.name === 'hs_ticket_category',
    );

    expect(categoryField.value).toBe('PRODUCT_ISSUE;BILLING_ISSUE;FEATURE_REQUEST');
  });

  it('handles empty categories array', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitSupportForm({
      firstName: 'Test',
      lastName: 'User',
      company: 'Company',
      email: 'test@example.com',
      categories: [],
      message: 'No category',
    });

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);
    const categoryField = body.fields.find(
      (f: { name: string }) => f.name === 'hs_ticket_category',
    );

    expect(categoryField.value).toBe('');
  });

  it('throws error when response is not ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });

    await expect(
      submitSupportForm({
        firstName: 'Jane',
        lastName: 'Doe',
        company: 'Acme',
        email: 'jane@acme.com',
        categories: ['GENERAL_INQUIRY'],
        message: 'Test',
      }),
    ).rejects.toThrow('HubSpot submission failed (400)');
  });

  it('throws error on server error status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      submitSupportForm({
        firstName: 'Jane',
        lastName: 'Doe',
        company: 'Acme',
        email: 'jane@acme.com',
        categories: ['PRODUCT_ISSUE'],
        message: 'Test',
      }),
    ).rejects.toThrow('HubSpot submission failed (500)');
  });
});

// ---------------------------------------------------------------------------
// submitContactSalesForm
// ---------------------------------------------------------------------------

describe('submitContactSalesForm', () => {
  it('splits name into first and last name', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitContactSalesForm({
      name: 'Jane Doe',
      company: 'Acme Inc',
      email: 'jane@acme.com',
    });

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);

    expect(body.fields).toContainEqual({ objectTypeId: '0-1', name: 'firstname', value: 'Jane' });
    expect(body.fields).toContainEqual({ objectTypeId: '0-1', name: 'lastname', value: 'Doe' });
  });

  it('handles multiple last name parts', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitContactSalesForm({
      name: 'Mary Jane Watson',
      company: 'Daily Bugle',
      email: 'mj@bugle.com',
    });

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);

    expect(body.fields).toContainEqual({ objectTypeId: '0-1', name: 'firstname', value: 'Mary' });
    expect(body.fields).toContainEqual({
      objectTypeId: '0-1',
      name: 'lastname',
      value: 'Jane Watson',
    });
  });

  it('handles single name (no last name)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitContactSalesForm({
      name: 'Madonna',
      company: 'Music Inc',
      email: 'madonna@music.com',
    });

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);

    expect(body.fields).toContainEqual({
      objectTypeId: '0-1',
      name: 'firstname',
      value: 'Madonna',
    });
    expect(body.fields).toContainEqual({ objectTypeId: '0-1', name: 'lastname', value: '' });
  });

  it('includes message field when provided', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitContactSalesForm({
      name: 'John Smith',
      company: 'Test Corp',
      email: 'john@test.com',
      message: 'I need help with pricing',
    });

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);

    expect(body.fields).toContainEqual({
      objectTypeId: '0-1',
      name: 'how_can_we_help',
      value: 'I need help with pricing',
    });
  });

  it('omits message field when not provided', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitContactSalesForm({
      name: 'John Smith',
      company: 'Test Corp',
      email: 'john@test.com',
    });

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);
    const messageField = body.fields.find((f: { name: string }) => f.name === 'how_can_we_help');

    expect(messageField).toBeUndefined();
  });

  it('sends to correct form endpoint', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await submitContactSalesForm({
      name: 'Test User',
      company: 'Company',
      email: 'test@example.com',
    });

    expect(fetchMock).toHaveBeenCalledWith(hubspotUrl(CONTACT_SALES_FORM_ID), expect.any(Object));
  });

  it('throws error when response is not ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422 });

    await expect(
      submitContactSalesForm({
        name: 'Jane Doe',
        company: 'Acme',
        email: 'jane@acme.com',
      }),
    ).rejects.toThrow('HubSpot submission failed (422)');
  });
});
