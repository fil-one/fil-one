import React, { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '../lib/query-client.js';
import { ComingSoonPage, type ComingSoonPageProps } from './ComingSoonPage.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const sharedProps: ComingSoonPageProps = {
  hubspotFormGuid: 'story-placeholder',
  title: 'Bucket Intelligence',
  description: 'Turn any Fil One bucket into a knowledge base you can ask questions to.',
  what: 'Bucket Intelligence turns your storage into a knowledge base you can talk to. Choose which buckets to index, upload documents as you normally would, and they are automatically indexed using RAG (Retrieval-Augmented Generation): your files are chunked into passages, converted into vector embeddings, and made searchable by meaning. When you ask a question, the most relevant passages are retrieved and passed to an LLM, which generates a precise answer grounded in your actual data. No vector database to run, no pipeline to maintain. Just upload and query.',
  features: [
    { title: 'Per-bucket indexing' },
    { title: 'Ask questions in natural language' },
    { title: 'Bring your own LLM' },
  ],
  useCases: [
    {
      category: 'Documents',
      title: 'Document Q&A',
      description:
        'Ask questions in natural language over any PDF, doc, or Markdown file. No setup, no extra tools.',
    },
    {
      category: 'Knowledge bases',
      title: 'Internal search',
      description:
        'Index your company wiki, runbooks, or support docs and get the right answer instantly.',
    },
    {
      category: 'Research',
      title: 'Research assistant',
      description:
        'Store papers, reports, and notes in a bucket and ask questions across all of them at once.',
    },
  ],
  whyFilOne: [
    {
      title: 'No RAG infrastructure to manage',
      description:
        'No vector database to provision, no embedding workers to run, no retrieval service to scale.',
    },
    {
      title: 'Data stays in your bucket',
      description:
        'The index is built from your data and stored alongside it in your Fil One bucket. Nothing is copied elsewhere.',
    },
    {
      title: 'Efficient re-indexing',
      description:
        'Only new or modified files are re-indexed, saving time and cutting your embedding costs.',
    },
    {
      title: 'Transparent costs',
      description:
        'Free during early access. After the alpha, Fil One will charge a flat fee per TB indexed.',
    },
  ],
  pricing: {
    headline: 'Free for early testers',
    subline:
      'Free during the early access period. LLM fees are paid directly to your chosen provider.',
    inclusions: [
      'Choose which buckets to index',
      'New files are indexed automatically',
      'Ask questions in natural language',
      'Bring your own LLM keys',
      'Disable at any time',
    ],
  },
  interestForm: {
    workloadLabel: 'Primary use case',
    workloadTypes: [
      'Document Q&A',
      'Internal knowledge base',
      'Customer support',
      'Research assistant',
      'Other',
    ],
    providersLabel: 'How are you handling RAG today?',
    providers: [
      'LangChain',
      'LlamaIndex',
      'OpenAI (native)',
      'Pinecone',
      'Building from scratch',
      'Not using RAG yet',
      'Other',
    ],
    timelines: [
      'Actively building now',
      'Planning in next 3 months',
      'Evaluating in next 6 months',
      'Just exploring',
    ],
    notesPlaceholder: 'What file types do you work with? How large is your document collection?',
  },
  faqs: [
    {
      question: 'What is RAG?',
      answer:
        'RAG (Retrieval-Augmented Generation) is a technique that improves LLM answers by first retrieving relevant passages from your documents and injecting them as context into the prompt.',
    },
    {
      question: 'What file types are supported at launch?',
      answer: 'PDF, Markdown, plain text, HTML, and DOCX.',
    },
    {
      question: 'Do I need to know how to code to use this?',
      answer:
        'No. You can enable Bucket Intelligence and start querying from the Fil One dashboard.',
    },
    {
      question: 'Do I need to run a vector database?',
      answer: 'No. Bucket Intelligence manages the vector index for you.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Query client with mocked user
// ---------------------------------------------------------------------------

function createQueryClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.me, {
    name: 'Filipa Ribeiro',
    email: 'filipa@fil.org',
    orgId: 'org_123',
    orgName: 'Fil One',
    emailVerified: true,
    mfaEnrollments: [],
  });
  return client;
}

function withQueryClient(Story: React.ComponentType) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <Story />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta<typeof ComingSoonPage> = {
  title: 'Pages/ComingSoonPage',
  component: ComingSoonPage,
  decorators: [withQueryClient],
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof ComingSoonPage>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Page: Story = {
  args: sharedProps,
};

// Opens the modal by clicking the trigger button on mount
function PageWithModalOpen(props: ComingSoonPageProps) {
  useEffect(() => {
    // Find the "Join the waitlist" button specifically
    const buttons = document.querySelectorAll<HTMLButtonElement>('button');
    for (const b of buttons) {
      if (b.textContent?.includes('Join the waitlist')) {
        b.click();
        break;
      }
    }
  }, []);

  return <ComingSoonPage {...props} />;
}

export const WaitlistModal: Story = {
  render: (args) => <PageWithModalOpen {...args} />,
  args: sharedProps,
};

// Shows the success state by mocking fetch and auto-submitting
function PageWithSuccess(props: ComingSoonPageProps) {
  useEffect(() => {
    // Mock fetch to return a successful HubSpot response
    const originalFetch = window.fetch;
    window.fetch = async () => new Response(JSON.stringify({ status: 'success' }), { status: 200 });

    // Open the modal
    const buttons = document.querySelectorAll<HTMLButtonElement>('button');
    for (const b of buttons) {
      if (b.textContent?.includes('Join the waitlist')) {
        b.click();
        break;
      }
    }

    // Submit the form after modal opens
    const timer = setTimeout(() => {
      const submitBtns = document.querySelectorAll<HTMLButtonElement>('button[type="submit"]');
      submitBtns[0]?.click();
    }, 100);

    return () => {
      clearTimeout(timer);
      window.fetch = originalFetch;
    };
  }, []);

  return <ComingSoonPage {...props} />;
}

export const WaitlistSuccess: Story = {
  render: (args) => <PageWithSuccess {...args} />,
  args: sharedProps,
};
