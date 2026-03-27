const HUBSPOT_PORTAL_ID = '51191454';
const HUBSPOT_FORM_ID = 'bae0c5ed-9724-4831-a285-a0b06fa56298';

type ContactSalesFields = {
  name: string;
  company: string;
  email: string;
  message?: string;
};

export async function submitContactSalesForm(fields: ContactSalesFields): Promise<void> {
  const [firstName, ...lastName] = fields.name.split(' ');
  const hubspotFields = [
    { objectTypeId: '0-1', name: 'firstname', value: firstName },
    { objectTypeId: '0-1', name: 'lastname', value: lastName.join(' ') },
    { objectTypeId: '0-1', name: 'company', value: fields.company },
    { objectTypeId: '0-1', name: 'email', value: fields.email },
  ];

  if (fields.message) {
    hubspotFields.push({ objectTypeId: '0-1', name: 'how_can_we_help', value: fields.message });
  }

  const res = await fetch(
    `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${HUBSPOT_FORM_ID}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: hubspotFields,
        context: {
          pageUri: window.location.href,
          pageName: 'Billing - Contact Sales',
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`HubSpot submission failed (${res.status})`);
  }
}
