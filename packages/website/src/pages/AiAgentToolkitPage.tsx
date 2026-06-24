import { ComingSoonPage } from '../components/ComingSoonPage.js';
import { submitAgentToolkitWaitlistForm } from '../lib/hubspot.js';

export function AiAgentToolkitPage() {
  return (
    <ComingSoonPage
      title="AI Agent Toolkit"
      description="Connect your AI tools and automations to Fil One."
      what="The AI Agent Toolkit lets you connect your storage to the AI tools you already use. Pick an integration, paste a config block, and your buckets are immediately available for your AI agents to use or to trigger automations from bucket events. Claude.ai and ChatGPT connect in a few clicks via OAuth."
      features={[
        { title: 'Connect AI assistants' },
        { title: 'Manage buckets straight from AI apps' },
        { title: 'Trigger automations from bucket events' },
      ]}
      useCases={[
        {
          category: 'AI assistants',
          title: 'Persistent memory for Claude',
          description:
            'Give Claude Desktop or Cursor access to a bucket so context, notes, and outputs persist across sessions.',
        },
        {
          category: 'Automations',
          title: 'React to new uploads automatically',
          description:
            'Trigger a Zap, n8n flow, or Make.com scenario the moment a file lands in a bucket, with no polling and no custom backend.',
        },
        {
          category: 'Multi-agent systems',
          title: 'Shared memory across agents',
          description:
            'Multiple agents read and write a shared bucket for coordination, without a separate state management layer.',
        },
      ]}
      whyFilOne={[
        {
          title: 'Your data stays yours',
          description:
            'Your agent data lives in your Fil One buckets, not a third-party SaaS. You own the keys, you own the data.',
        },
        {
          title: 'Works with your existing buckets',
          description:
            'No new bucket setup, no extra credentials. The toolkit is an add-on to your existing Fil One account. Enable it and your buckets are immediately available to connect.',
        },
        {
          title: 'No infrastructure to manage',
          description:
            'Fil One handles durability, redundancy, and scaling. Your team ships agents, not ops runbooks.',
        },
        {
          title: 'Free during early access',
          description:
            'The AI Agent Toolkit is included at no extra charge during the early access period. Standard Fil One storage rates apply.',
        },
      ]}
      pricing={{
        headline: 'Free for early testers',
        subline: 'Free during the early access period. Standard Fil One storage rates apply.',
        inclusions: [
          'Connect AI tools and automations',
          'Works with your existing buckets',
          'No egress fees',
          'Revoke access any time',
        ],
      }}
      hubspotFormGuid={import.meta.env.VITE_HUBSPOT_AGENT_TOOLKIT_FORM_GUID}
      onWaitlistSubmit={(v) =>
        submitAgentToolkitWaitlistForm({
          formId: v.formId,
          firstName: v.firstName,
          lastName: v.lastName,
          email: v.email,
          tools: v.providers,
          otherTool: v.otherProvider,
          timeline: v.timeline,
          teamSize: v.teamSize,
          notes: v.notes,
        })
      }
      interestForm={{
        providersLabel: 'Which tools are you connecting?',
        providersMultiple: true,
        showStorageAmount: false,
        providers: [
          'Claude',
          'Cursor',
          'Continue',
          'ChatGPT',
          'Zapier',
          'n8n',
          'Make.com',
          'Not sure yet',
          'Other',
        ],
        timelines: [
          'Actively building now',
          'Planning in next 3 months',
          'Evaluating in next 6 months',
          'Just exploring',
        ],
        notesPlaceholder: 'What are you building with Fil One?',
      }}
      faqs={[
        {
          question: 'What is MCP?',
          answer:
            'Model Context Protocol is an open standard developed by Anthropic for connecting AI assistants to external data sources and tools. It lets hosts like Claude Desktop discover and call tools (like reading and writing files) exposed by an MCP server. The AI Agent Toolkit includes a hosted MCP server so you do not need to run one yourself.',
        },
        {
          question: 'Which apps are supported at launch?',
          answer:
            'AI assistants via MCP: Claude Desktop, Cursor, and Continue. OAuth: Claude.ai and ChatGPT. Automations: Zapier, n8n, Make.com, and outbound webhooks. Any MCP-compatible host or HTTP-capable tool also works directly.',
        },
        {
          question: 'Do I need to set up new buckets?',
          answer:
            'No. The toolkit connects to your existing Fil One buckets. Enable the add-on, pick an integration, and scope it to whichever buckets you want to expose.',
        },
        {
          question: 'Is my agent data private?',
          answer:
            'Yes. Fil One supports private buckets with access controls. Only the API key or OAuth token you issued can access your data unless you explicitly grant additional access.',
        },
        {
          question: 'I already use Fil One in code. Do I need this?',
          answer:
            'Not necessarily. LangChain, LlamaIndex, Vercel AI SDK, CrewAI, and the Fil One SDK all work directly with a standard Fil One API key, no toolkit required. The AI Agent Toolkit is specifically for connecting AI apps and no-code automation tools that expect MCP or OAuth.',
        },
        {
          question: 'How much does it cost?',
          answer:
            'The toolkit is free during early access. Standard Fil One storage rates apply to the data your agents read and write.',
        },
      ]}
    />
  );
}
