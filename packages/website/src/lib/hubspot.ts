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

export type WaitlistFields = {
  formId: string;
  firstName: string;
  lastName: string;
  email: string;
  primaryUseCase: string;
  ragProvider: string;
  timeline: string;
  teamSize: string;
  storageAmount: string;
  notes: string;
};

// Shared submit for waitlist forms. Forwards the HubSpot tracking cookie when present
// so submissions link to an existing visitor's analytics session.
async function submitWaitlistToHubSpot(
  formId: string,
  fields: { name: string; value: string }[],
): Promise<void> {
  const hutk = document.cookie
    .split('; ')
    .find((row) => row.startsWith('hubspotutk='))
    ?.split('=')[1];

  const res = await fetch(
    `https://api.hsforms.com/submissions/v3/integration/submit/${HUBSPOT_PORTAL_ID}/${formId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields,
        context: {
          pageUri: window.location.href,
          ...(hutk ? { hutk } : {}),
        },
      }),
    },
  );

  if (!res.ok) throw new Error('Waitlist submission failed');
}

export async function submitWaitlistForm(fields: WaitlistFields): Promise<void> {
  return submitWaitlistToHubSpot(fields.formId, [
    { name: 'firstname', value: fields.firstName },
    { name: 'lastname', value: fields.lastName },
    { name: 'email', value: fields.email },
    { name: 'primary_use_case', value: fields.primaryUseCase },
    { name: 'how_are_you_handling_rag_today', value: fields.ragProvider },
    { name: 'timeline', value: fields.timeline },
    { name: 'team_size', value: fields.teamSize },
    { name: 'amount_of_storage_rag', value: fields.storageAmount },
    { name: 'notes', value: fields.notes },
  ]);
}

export type AgentToolkitWaitlistFields = {
  formId: string;
  firstName: string;
  lastName: string;
  email: string;
  tools: string[];
  otherTool: string;
  timeline: string;
  teamSize: string;
  notes: string;
};

export async function submitAgentToolkitWaitlistForm(
  fields: AgentToolkitWaitlistFields,
): Promise<void> {
  const hubspotFields = [
    { name: 'firstname', value: fields.firstName },
    { name: 'lastname', value: fields.lastName },
    { name: 'email', value: fields.email },
    { name: 'ai_tools', value: fields.tools.join(';') },
    { name: 'ai_toolkit_timeline', value: fields.timeline },
    { name: 'team_size', value: fields.teamSize },
    { name: 'ai_toolkit_notes', value: fields.notes },
  ];

  // Free-text tool name goes to its own property; the checkbox field keeps the literal "Other".
  const otherTool = fields.otherTool.trim();
  if (otherTool) {
    hubspotFields.push({ name: 'other_tool', value: otherTool });
  }

  return submitWaitlistToHubSpot(fields.formId, hubspotFields);
}
