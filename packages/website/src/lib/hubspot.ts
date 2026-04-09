const HUBSPOT_PORTAL_ID = '51191454';
const HUBSPOT_CONTACT_SALES_FORM_ID = 'bae0c5ed-9724-4831-a285-a0b06fa56298';
const HUBSPOT_SUPPORT_FORM_ID = '44da45a4-b99b-4886-988a-70e27308322d';

type HubSpotField = { objectTypeId: string; name: string; value: string };

async function submitToHubSpot(
  formId: string,
  fields: HubSpotField[],
  pageName: string,
): Promise<void> {
  const res = await fetch(
    `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${formId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields,
        context: {
          pageUri: window.location.href,
          pageName,
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`HubSpot submission failed (${res.status})`);
  }
}

type ContactSalesFields = {
  name: string;
  company: string;
  email: string;
  message?: string;
};

export async function submitContactSalesForm(fields: ContactSalesFields): Promise<void> {
  const [firstName, ...lastName] = fields.name.split(' ');
  const hubspotFields: HubSpotField[] = [
    { objectTypeId: '0-1', name: 'firstname', value: firstName },
    { objectTypeId: '0-1', name: 'lastname', value: lastName.join(' ') },
    { objectTypeId: '0-1', name: 'company', value: fields.company },
    { objectTypeId: '0-1', name: 'email', value: fields.email },
  ];

  if (fields.message) {
    hubspotFields.push({ objectTypeId: '0-1', name: 'how_can_we_help', value: fields.message });
  }

  return submitToHubSpot(HUBSPOT_CONTACT_SALES_FORM_ID, hubspotFields, 'Billing - Contact Sales');
}

type SupportFields = {
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  categories: string[];
  message: string;
};

export async function submitSupportForm(fields: SupportFields): Promise<void> {
  const hubspotFields: HubSpotField[] = [
    { objectTypeId: '0-1', name: 'firstname', value: fields.firstName },
    { objectTypeId: '0-1', name: 'lastname', value: fields.lastName },
    { objectTypeId: '0-1', name: 'company', value: fields.company },
    { objectTypeId: '0-1', name: 'email', value: fields.email },
    { objectTypeId: '0-5', name: 'hs_ticket_category', value: fields.categories.join(';') },
    { objectTypeId: '0-5', name: 'content', value: fields.message },
  ];

  return submitToHubSpot(HUBSPOT_SUPPORT_FORM_ID, hubspotFields, 'Support');
}
