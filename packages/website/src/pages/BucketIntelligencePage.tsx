import { ComingSoonPage } from '../components/ComingSoonPage.js';

export function BucketIntelligencePage() {
  return (
    <ComingSoonPage
      hubspotFormGuid={import.meta.env.VITE_HUBSPOT_BUCKET_INTELLIGENCE_WAITLIST_FORM_GUID}
      title="Bucket Intelligence"
      description="Turn any Fil One bucket into a knowledge base you can ask questions to."
      what="Bucket Intelligence turns your storage into a knowledge base you can talk to. Choose which buckets to index, upload documents as you normally would, and they are automatically indexed using RAG (Retrieval-Augmented Generation): your files are chunked into passages, converted into vector embeddings, and made searchable by meaning. When you ask a question, the most relevant passages are retrieved and passed to an LLM, which generates a precise answer grounded in your actual data. No vector database to run, no pipeline to maintain. Just upload and query."
      features={[
        { title: 'Per-bucket indexing' },
        { title: 'Ask questions in natural language' },
        { title: 'Bring your own LLM' },
      ]}
      useCases={[
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
            'Index your company wiki, runbooks, or support docs and get the right answer instantly, without digging through files manually.',
        },
        {
          category: 'Research',
          title: 'Research assistant',
          description:
            'Store papers, reports, and notes in a bucket and ask questions across all of them at once.',
        },
      ]}
      whyFilOne={[
        {
          title: 'No RAG infrastructure to manage',
          description:
            'No vector database to provision, no embedding workers to run, no retrieval service to scale. Fil One handles the full pipeline, you just upload files and query.',
        },
        {
          title: 'Data stays in your bucket',
          description:
            'The index is built from your data and stored alongside it in your Fil One bucket. Nothing is copied elsewhere.',
        },
        {
          title: 'Efficient re-indexing',
          description:
            'Fil One assigns every file a unique content identifier (CID). When your bucket changes, only new or modified files are re-indexed, saving time and cutting your embedding costs.',
        },
        {
          title: 'Transparent costs',
          description:
            'Free during early access. After the alpha, Fil One will charge a flat fee per TB indexed. LLM and embedding costs always go directly to your provider, no markup, no hidden per-query fees.',
        },
      ]}
      pricing={{
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
      }}
      interestForm={{
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
        notesPlaceholder:
          'What file types do you work with? How large is your document collection?',
      }}
      faqs={[
        {
          question: 'What is RAG?',
          answer:
            'RAG (Retrieval-Augmented Generation) is a technique that improves LLM answers by first retrieving relevant passages from your documents and injecting them as context into the prompt. This lets the model answer questions grounded in your data rather than relying solely on its training.',
        },
        {
          question: 'What file types are supported at launch?',
          answer:
            'PDF, Markdown, plain text, HTML, and DOCX. Additional formats (including CSV and PowerPoint) are on the roadmap.',
        },
        {
          question: 'Do I need to know how to code to use this?',
          answer:
            'No. You can enable Bucket Intelligence, choose which buckets to index, and start querying from the Fil One dashboard. A query API is also available for developers who want to integrate it into their own apps.',
        },
        {
          question: 'Do I need to run a vector database?',
          answer:
            'No. Bucket Intelligence manages the vector index for you. There is no separate vector DB to provision, configure, or scale.',
        },
        {
          question: 'Which AI providers are supported?',
          answer:
            'For embeddings: OpenAI (text-embedding-3-small and text-embedding-3-large) and Voyage (voyage-3). For generation: OpenAI (GPT-4o family) and Anthropic (Claude 3.7 family). Your API keys are stored encrypted and only used within your account.',
        },
        {
          question: 'How quickly can I start querying after uploading?',
          answer:
            'Near real-time. New files uploaded to an indexed bucket are typically available for querying within seconds.',
        },
        {
          question: 'What happens if I delete a file from my bucket?',
          answer:
            'The corresponding index entries are removed automatically. Queries will never return passages from deleted documents.',
        },
        {
          question: 'Can I query across multiple buckets?',
          answer:
            'Cross-bucket queries are on the roadmap. At launch, each query targets a single bucket index.',
        },
      ]}
    />
  );
}
