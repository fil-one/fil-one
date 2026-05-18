import { useState } from 'react';

import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { useAddOnState } from '../contexts/addOnState.js';
import { Card } from '../components/Card.js';
import { Heading } from '../components/Heading/Heading.js';
import { Input } from '../components/Input.js';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../components/Modal/index.js';
import { Select } from '../components/Select.js';
import { ComingSoonPage } from '../components/ComingSoonPage.js';

type PageState = 'coming-soon' | 'disabled' | 'active';

// ---------------------------------------------------------------------------
// Shared product view (disabled + active)
// ---------------------------------------------------------------------------

const MOCK_BUCKETS = [
  { name: 'my-docs-bucket', docs: 847, size: '210 MB', lastIndexed: '1 min ago' },
  { name: 'research-papers', docs: 400, size: '114 MB', lastIndexed: '4 min ago' },
];

function ToggleConfirmModal({
  enabled,
  open,
  onClose,
  onConfirm,
}: {
  enabled: boolean;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="sm">
      <ModalHeader onClose={onClose}>
        {enabled ? 'Disable RAG Pipeline?' : 'Enable RAG Pipeline?'}
      </ModalHeader>
      <ModalBody>
        {enabled ? (
          <p className="text-sm text-zinc-600">
            Indexing will stop and your buckets will no longer be queryable via the API. Your
            documents and existing index data are not deleted.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                Pricing
              </p>
              <div className="space-y-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-zinc-600">Per TB stored (with indexing)</span>
                  <span className="text-sm font-semibold text-zinc-900">Flat monthly fee</span>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-zinc-600">LLM / embedding costs</span>
                  <span className="text-sm font-semibold text-zinc-900">
                    Billed by your provider
                  </span>
                </div>
              </div>
            </div>
            <p className="text-xs text-zinc-500">
              Rates published before launch. Disable at any time.
            </p>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant={enabled ? 'destructive' : 'primary'} size="md" onClick={onConfirm}>
          {enabled ? 'Disable' : 'Enable'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function RagPipelineProductView({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function handleSave() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const stats = enabled
    ? [
        { label: 'Documents indexed', value: '1,247' },
        { label: 'Index size', value: '324 MB' },
        { label: 'Last indexed', value: '1 min ago' },
      ]
    : [
        { label: 'Documents indexed', value: '—' },
        { label: 'Index size', value: '—' },
        { label: 'Last indexed', value: '—' },
      ];

  return (
    <>
      <div className="px-10 py-12 pb-20">
        <div className="max-w-2xl space-y-12">
          <div className="flex items-start justify-between gap-6">
            <Heading
              tag="h1"
              size="2xl"
              description={
                enabled
                  ? 'Indexing is active. Your buckets are queryable via the API.'
                  : 'Enable RAG Pipeline to start indexing your buckets.'
              }
            >
              <span className="inline-flex items-center gap-2.5">
                RAG Pipeline
                {enabled ? (
                  <Badge color="green" size="sm" strength="strong">
                    Active
                  </Badge>
                ) : (
                  <Badge color="grey" size="sm" strength="strong">
                    Not enabled
                  </Badge>
                )}
              </span>
            </Heading>
            <div className="mt-1 flex-shrink-0">
              {enabled ? (
                <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
                  Disable
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={() => setConfirmOpen(true)}>
                  Enable RAG Pipeline
                </Button>
              )}
            </div>
          </div>

          <div className={`grid grid-cols-3 gap-3 ${!enabled ? 'opacity-50' : ''}`}>
            {stats.map((s) => (
              <div key={s.label} className="rounded-xl border border-zinc-200 bg-white p-4">
                <p className="mb-1 text-[11px] text-zinc-400">{s.label}</p>
                <p className="text-xl font-semibold text-zinc-900">{s.value}</p>
              </div>
            ))}
          </div>

          <section>
            <Heading tag="h2" size="lg" className="mb-4">
              Indexed buckets
            </Heading>
            {enabled ? (
              <>
                <Card padding="none" className="overflow-hidden">
                  {MOCK_BUCKETS.map((b, i) => (
                    <div
                      key={b.name}
                      className={`flex items-center justify-between px-5 py-4 ${i < MOCK_BUCKETS.length - 1 ? 'border-b border-zinc-100' : ''}`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="h-2 w-2 flex-shrink-0 rounded-full bg-green-500" />
                        <div>
                          <p className="text-sm font-medium text-zinc-800">{b.name}</p>
                          <p className="text-xs text-zinc-400">
                            {b.docs} docs · {b.size} · indexed {b.lastIndexed}
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm">
                        Disable
                      </Button>
                    </div>
                  ))}
                </Card>
                <div className="mt-2">
                  <Button variant="ghost" size="sm">
                    Enable on another bucket
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
                <p className="text-sm text-zinc-500">
                  Enable RAG Pipeline to start indexing your buckets.
                </p>
                <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
                  Enable
                </Button>
              </div>
            )}
          </section>

          <section>
            <Heading tag="h2" size="lg" className="mb-4">
              Embedding configuration
            </Heading>
            <Card padding="md" className="space-y-5">
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                  Provider
                </label>
                <Select value={provider} onChange={setProvider}>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="cohere">Cohere</option>
                  <option value="custom">Self-hosted (OpenAI-compatible)</option>
                </Select>
              </div>
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                  API Key
                </label>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="sk-••••••••••••••••"
                    value={apiKey}
                    onChange={setApiKey}
                    className="flex-1"
                  />
                  <Button variant="ghost" size="md" onClick={handleSave}>
                    {saved ? 'Saved' : 'Save'}
                  </Button>
                </div>
                <p className="mt-1.5 text-xs text-zinc-400">
                  Stored encrypted. Used only for indexing and query operations within your account.
                </p>
              </div>
            </Card>
          </section>

          <section>
            <Heading tag="h2" size="lg" className="mb-1">
              Query API
            </Heading>
            <p className="mb-4 text-sm text-zinc-500">
              Query your indexed buckets using the standard Fil One API.
            </p>
            <Card padding="none" className="overflow-hidden">
              <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-2.5">
                <p className="text-[11px] font-medium text-zinc-400">
                  POST /v1/buckets/:bucket/query
                </p>
              </div>
              <pre className="overflow-x-auto px-4 py-4 text-[12px] leading-relaxed text-zinc-700">
                {`{
  "query": "What are the retention policies?",
  "top_k": 5,
  "model": "gpt-4o"
}`}
              </pre>
            </Card>
          </section>
        </div>
      </div>

      <ToggleConfirmModal
        enabled={enabled}
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          onToggle();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function RagPipelinePage() {
  const { states, setStatus } = useAddOnState();
  const state = (states['/rag-pipeline'] ?? 'coming-soon') as PageState;

  if (state === 'active')
    return (
      <RagPipelineProductView
        enabled={true}
        onToggle={() => setStatus('/rag-pipeline', 'disabled')}
      />
    );
  if (state === 'disabled')
    return (
      <RagPipelineProductView
        enabled={false}
        onToggle={() => setStatus('/rag-pipeline', 'active')}
      />
    );

  return (
    <ComingSoonPage
      title="RAG Pipeline"
      description="Make any Fil One bucket queryable. Bring your own LLM keys."
      what="RAG Pipeline turns any Fil One bucket into a queryable knowledge base. Upload documents as you normally would — RAG Pipeline automatically chunks and indexes them. When you run a query, it retrieves the most relevant passages and passes them to your LLM of choice. Your data never leaves your bucket, and you pay your LLM provider directly with your own API keys."
      features={[
        {
          category: 'Indexing',
          title: 'Auto-indexing',
          description:
            'Files uploaded to your bucket are automatically detected, chunked, and indexed. No pipeline to configure — just upload and query.',
        },
        {
          category: 'Retrieval',
          title: 'Semantic search',
          description:
            'Run vector similarity search across your entire document corpus. Returns the top-k most relevant passages ranked by relevance score.',
        },
        {
          category: 'Privacy',
          title: 'Bring your own keys',
          description:
            'Use your own OpenAI, Anthropic, or Cohere API keys for embeddings and completions. We never pool or resell LLM capacity.',
        },
      ]}
      useCases={[
        {
          category: 'Documents',
          title: 'Document Q&A',
          description:
            'Let users ask questions over large PDF or Markdown libraries. No chunking scripts, no vector DB to provision.',
        },
        {
          category: 'Knowledge bases',
          title: 'Internal search',
          description:
            'Index your company wiki, runbooks, or support docs. Surface the right passage in a single API call.',
        },
        {
          category: 'Research',
          title: 'Research assistant',
          description:
            'Store papers, reports, and notes in a bucket and retrieve semantically related passages across the entire corpus.',
        },
      ]}
      whyFilOne={[
        {
          title: 'Data residency',
          description:
            'Your documents stay in your Fil One bucket. The index is built from your data and stored alongside it — nothing leaves your account.',
        },
        {
          title: 'No vendor lock-in',
          description:
            'Switch embedding models without re-ingesting. The pipeline re-indexes on demand so you can experiment freely.',
        },
        {
          title: 'Cost transparency',
          description:
            'You pay your LLM provider directly. No hidden embedding fees or per-query charges on top of what you already pay.',
        },
        {
          title: 'Works with existing buckets',
          description:
            'Enable RAG Pipeline on any existing bucket with one click. No migration, no copying data, no downtime.',
        },
      ]}
      pricing={{
        headline: 'Usage-based add-on',
        subline:
          'Fil One charges a flat fee per TB stored with indexing enabled. All LLM and embedding costs go directly to your provider — Fil One never touches that billing.',
        inclusions: [
          'Flat fee per TB stored, billed on your Fil One invoice',
          'LLM and embedding costs paid directly to your provider',
          'No egress fees',
          'Rates published before launch',
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
        providers: ['OpenAI', 'Anthropic', 'Cohere', 'Self-hosted model', 'Other'],
        timelines: [
          'Actively building now',
          'Planning in next 3 months',
          'Evaluating in next 6 months',
          'Just exploring',
        ],
        notesPlaceholder: 'What file types do you work with? How large is your document corpus?',
      }}
      faqs={[
        {
          question: 'What file types are supported at launch?',
          answer:
            'PDF, Markdown, plain text, HTML, and DOCX. Additional formats — including CSV and PowerPoint — are on the roadmap.',
        },
        {
          question: 'Do you store my LLM API keys?',
          answer:
            'Keys are stored encrypted at rest and are only used for indexing and query operations within your account. You can rotate or remove them at any time.',
        },
        {
          question: 'How quickly are new files indexed?',
          answer:
            'Near real-time — new files uploaded to an indexed bucket are typically available for search within seconds.',
        },
        {
          question: 'Can I use my own embedding model?',
          answer:
            'Yes. Any OpenAI-compatible embeddings endpoint is supported. Bring a self-hosted model or use a third-party provider.',
        },
        {
          question: 'What happens if I delete a file from my bucket?',
          answer:
            'The corresponding index entries are removed automatically. Your search results will never reference deleted documents.',
        },
        {
          question: 'Can I query across multiple buckets?',
          answer:
            'Cross-bucket queries are on the roadmap. At launch, each query targets a single bucket index.',
        },
      ]}
      onEnable={() => setStatus('/rag-pipeline', 'disabled')}
    />
  );
}
