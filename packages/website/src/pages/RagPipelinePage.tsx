/* eslint-disable max-lines */
import { useState } from 'react';
import {
  ChatCircleIcon,
  CheckIcon,
  CubeIcon,
  LightningIcon,
  PaperPlaneTiltIcon,
  ProhibitIcon,
  TerminalIcon,
} from '@phosphor-icons/react/dist/ssr';

import { Alert } from '../components/Alert.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { CodeBlock } from '../components/CodeBlock.js';
import { EmptyStateCard } from '../components/EmptyStateCard.js';
import { Heading } from '../components/Heading/Heading.js';
import { Input } from '../components/Input.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal/index.js';
import { Select } from '../components/Select.js';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs/index.js';
import { ComingSoonPage } from '../components/ComingSoonPage.js';
import { useAddOnState } from '../contexts/addOnState.js';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type PageState = 'coming-soon' | 'disabled' | 'active';

const ALL_BUCKETS_VALUE = '__all__';

const MOCK_BUCKETS = [
  { name: 'my-docs-bucket', files: 847, size: '210 MB', lastSynced: '1 min ago', indexed: true },
  { name: 'research-papers', files: 400, size: '114 MB', lastSynced: '4 min ago', indexed: true },
  { name: 'marketing-assets', files: 120, size: '540 MB', lastSynced: null, indexed: false },
];

const INDEXED_BUCKETS = MOCK_BUCKETS.filter((b) => b.indexed);

// ---------------------------------------------------------------------------
// ToggleConfirmModal
// ---------------------------------------------------------------------------

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
                <div className="flex items-center justify-between gap-6">
                  <span className="text-sm text-zinc-600">Per TB stored (with indexing)</span>
                  <span className="flex-shrink-0 text-sm font-semibold text-zinc-900">
                    $15 / TB / month
                  </span>
                </div>
                <div className="flex items-center justify-between gap-6">
                  <span className="text-sm text-zinc-600">LLM / embedding costs</span>
                  <span className="flex-shrink-0 text-sm font-semibold text-zinc-900">
                    Your provider
                  </span>
                </div>
              </div>
            </div>
            <p className="text-xs text-zinc-500">Disable at any time.</p>
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

// ---------------------------------------------------------------------------
// BucketsTab
// ---------------------------------------------------------------------------

function BucketsTab({ enabled }: { enabled: boolean }) {
  return (
    <section className="space-y-6">
      <Heading
        tag="h2"
        size="lg"
        description="Manage which buckets are indexed and available for querying."
      >
        Buckets
      </Heading>
      <Card padding="none" className="overflow-hidden">
        {MOCK_BUCKETS.map((b, i) => (
          <div
            key={b.name}
            className={`flex items-center justify-between px-5 py-4 transition-opacity ${i < MOCK_BUCKETS.length - 1 ? 'border-b border-zinc-100' : ''} ${!enabled ? 'opacity-60' : ''}`}
          >
            <div className="flex items-center gap-3">
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${enabled && b.indexed ? 'bg-green-500' : 'bg-zinc-300'}`}
              />
              <div>
                <p className="text-sm font-medium text-zinc-800">{b.name}</p>
                <p className="text-xs text-zinc-400">
                  {!enabled || !b.indexed ? (
                    'Not indexed'
                  ) : (
                    <>
                      <span className="text-zinc-500">{b.files.toLocaleString()}</span>
                      {' files indexed'}
                      <span aria-hidden="true"> · </span>
                      <span className="text-zinc-500">{b.size}</span>
                      <span aria-hidden="true"> · </span>
                      {'Last synced '}
                      <span className="text-zinc-500">{b.lastSynced ?? '—'}</span>
                    </>
                  )}
                </p>
              </div>
            </div>
            {enabled && b.indexed && (
              <Button variant="ghost" size="sm">
                Disable
              </Button>
            )}
          </div>
        ))}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ModelSection (sub-component used in ModelsTab)
// ---------------------------------------------------------------------------

type ModelSectionProps = {
  icon: React.ReactNode;
  heading: string;
  description: string;
  providerOptions: Array<{ value: string; label: string }>;
  modelOptions: Array<{ value: string; label: string }>;
};

function ModelSection({
  icon,
  heading,
  description,
  providerOptions,
  modelOptions,
}: ModelSectionProps) {
  const [provider, setProvider] = useState(providerOptions[0]?.value ?? '');
  const [model, setModel] = useState(modelOptions[0]?.value ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-5">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <span className="text-zinc-400">{icon}</span>
          <span className="text-sm font-semibold text-zinc-800">{heading}</span>
        </div>
        <p className="mt-1 text-xs text-zinc-500">{description}</p>
      </div>
      <div>
        <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
          Provider
        </label>
        <Select value={provider} onChange={setProvider}>
          {providerOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
          Model
        </label>
        <Select value={model} onChange={setModel}>
          {modelOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
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
          <Button
            variant="ghost"
            size="md"
            icon={saved ? CheckIcon : undefined}
            onClick={handleSave}
          >
            {saved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelsTab
// ---------------------------------------------------------------------------

function ModelsTab({ enabled }: { enabled: boolean }) {
  return (
    <div className="space-y-6">
      <Heading
        tag="h2"
        size="lg"
        description="Configure the models used for indexing and querying your buckets."
      >
        Models
      </Heading>
      <div
        className={`grid grid-cols-2 gap-6${!enabled ? ' pointer-events-none select-none opacity-60' : ''}`}
      >
        <Card padding="md">
          <ModelSection
            icon={<CubeIcon size={16} />}
            heading="Index model"
            description="Creates embeddings when files are uploaded to your buckets."
            providerOptions={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'cohere', label: 'Cohere' },
              { value: 'self-hosted', label: 'Self-hosted' },
            ]}
            modelOptions={[
              { value: 'text-embedding-3-small', label: 'text-embedding-3-small' },
              { value: 'text-embedding-3-large', label: 'text-embedding-3-large' },
              { value: 'text-embedding-ada-002', label: 'text-embedding-ada-002' },
            ]}
          />
        </Card>
        <Card padding="md">
          <ModelSection
            icon={<ChatCircleIcon size={16} />}
            heading="Query model"
            description="Generates answers when you search across your indexed buckets."
            providerOptions={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'cohere', label: 'Cohere' },
            ]}
            modelOptions={[
              { value: 'gpt-4o', label: 'gpt-4o' },
              { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
              { value: 'claude-3-5-sonnet', label: 'claude-3-5-sonnet' },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatTab
// ---------------------------------------------------------------------------

function ChatTab({ enabled, goToBuckets }: { enabled: boolean; goToBuckets: () => void }) {
  const [chatBucket, setChatBucket] = useState<string>(ALL_BUCKETS_VALUE);
  const [input, setInput] = useState('');

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <Heading
          tag="h2"
          size="lg"
          description="Ask questions across your indexed buckets directly from here."
        >
          <span className="inline-flex items-center gap-2.5">
            Chat
            {enabled && (
              <Badge color="blue" size="sm">
                Test mode
              </Badge>
            )}
          </span>
        </Heading>
        {enabled && (
          <div className="mt-1 flex flex-shrink-0 items-center gap-3">
            <span className="flex-shrink-0 text-xs font-medium text-zinc-400">Select bucket</span>
            <div className="w-44">
              <Select value={chatBucket} onChange={setChatBucket}>
                <option value={ALL_BUCKETS_VALUE}>All buckets</option>
                {INDEXED_BUCKETS.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        )}
      </div>

      {!enabled ? (
        <EmptyStateCard
          icon={PaperPlaneTiltIcon}
          iconColor="grey"
          title="Chat isn't available yet"
          description="Enable RAG Pipeline to start chatting with your buckets."
        >
          <Button variant="ghost" size="sm" onClick={goToBuckets}>
            Enable RAG Pipeline
          </Button>
        </EmptyStateCard>
      ) : (
        <Card padding="none" className="flex h-96 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-5">
            <div className="flex gap-3">
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-500">
                AI
              </span>
              <div className="rounded-lg bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
                Hi! Ask me anything about your indexed documents.
              </div>
            </div>
          </div>
          <div className="border-t border-zinc-100 p-3">
            <div className="flex gap-2">
              <Input
                placeholder="Ask a question…"
                value={input}
                onChange={setInput}
                className="flex-1"
              />
              <Button variant="primary" size="md" onClick={() => setInput('')}>
                Send
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// IntegrateTab
// ---------------------------------------------------------------------------

function IntegrateTab({ enabled }: { enabled: boolean }) {
  const [selected, setSelected] = useState<string>(ALL_BUCKETS_VALUE);

  const arg = selected === ALL_BUCKETS_VALUE ? '*' : selected;
  const mcpCode = JSON.stringify(
    {
      mcpServers: {
        filone: {
          command: 'npx',
          args: ['@filone/mcp-server', '--buckets', arg],
          env: { FILONE_KEY: 'sk-live_...' },
        },
      },
    },
    null,
    2,
  );

  const queryCode = `POST /v1/buckets/${arg}/query\n${JSON.stringify({ query: 'What are the retention policies?', top_k: 5, model: 'gpt-4o' }, null, 2)}`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <Heading
          tag="h2"
          size="lg"
          description="Connect your buckets to AI apps and your own code."
        >
          Integrate
        </Heading>
        {enabled && (
          <div className="mt-1 flex flex-shrink-0 items-center gap-3">
            <span className="flex-shrink-0 text-xs font-medium text-zinc-400">Select bucket</span>
            <div className="w-44">
              <Select value={selected} onChange={setSelected}>
                <option value={ALL_BUCKETS_VALUE}>All buckets</option>
                {MOCK_BUCKETS.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        )}
      </div>
      {!enabled && (
        <Alert
          variant="grey"
          description="These endpoints will be active once you enable RAG Pipeline."
        />
      )}
      <div className="grid grid-cols-2 divide-x divide-zinc-100">
        <div className="pr-6">
          <div className="flex items-center gap-2">
            <TerminalIcon size={16} className="text-zinc-400" />
            <span className="text-sm font-semibold text-zinc-800">MCP endpoint</span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            For Claude Desktop, Cursor, and any MCP-compatible client.
          </p>
          <div className={`mt-4${!enabled ? ' pointer-events-none select-none blur-md' : ''}`}>
            <CodeBlock code={mcpCode} language="json" />
          </div>
        </div>
        <div className="pl-6">
          <div className="flex items-center gap-2">
            <LightningIcon size={16} className="text-zinc-400" />
            <span className="text-sm font-semibold text-zinc-800">Query API</span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">Call directly from your app or agent.</p>
          <div className={`mt-4${!enabled ? ' pointer-events-none select-none blur-md' : ''}`}>
            <CodeBlock code={queryCode} language="bash" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RagPipelineView
// ---------------------------------------------------------------------------

function RagPipelineView({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [jumpKey, setJumpKey] = useState(0);
  const [defaultTab, setDefaultTab] = useState(0);

  function goToBuckets() {
    setDefaultTab(0);
    setJumpKey((k) => k + 1);
  }

  const stats = enabled
    ? [
        { label: 'Files indexed', value: '1,247', sub: 'across all buckets' },
        { label: 'Index size', value: '324 MB', sub: 'total storage used' },
        { label: 'Last synced', value: '1 min ago', sub: 'most recent bucket' },
        { label: 'Est. cost', value: '$4.86', sub: '$15 / TB / month' },
      ]
    : [
        { label: 'Files indexed', value: '—', sub: 'Available once enabled' },
        { label: 'Index size', value: '—', sub: 'Available once enabled' },
        { label: 'Last synced', value: '—', sub: 'Available once enabled' },
        { label: 'Est. cost', value: '—', sub: 'Available once enabled' },
      ];

  return (
    <>
      <div className="px-10 py-12 pb-20">
        <div className="space-y-8">
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
                  <Badge color="green" size="sm" strength="strong" dot>
                    Active
                  </Badge>
                ) : (
                  <Badge color="grey" size="sm" strength="strong">
                    Disabled
                  </Badge>
                )}
              </span>
            </Heading>
            <div className="mt-1 flex-shrink-0">
              {enabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ProhibitIcon}
                  onClick={() => setConfirmOpen(true)}
                >
                  Disable
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={() => setConfirmOpen(true)}>
                  Enable RAG Pipeline
                </Button>
              )}
            </div>
          </div>

          <div
            className={`grid grid-cols-4 gap-3 ${!enabled ? 'pointer-events-none select-none opacity-60' : ''}`}
          >
            {stats.map((s) => (
              <div key={s.label} className="rounded-xl border border-zinc-200 bg-white p-5">
                <p className="mb-2.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  {s.label}
                </p>
                <p className="text-xl font-semibold text-zinc-950">{s.value}</p>
                <p className="mt-1 text-xs text-zinc-400">{s.sub}</p>
              </div>
            ))}
          </div>

          {enabled && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4">
              <p className="text-sm font-semibold text-blue-900">
                Saving you ~12 hours and ~$47 in embedding costs this month.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-blue-500">
                Every file has a unique content address (CID) — so only changed files are ever
                re-indexed. No full corpus scans, no redundant embedding calls.
              </p>
            </div>
          )}

          <Tabs key={jumpKey} defaultIndex={defaultTab}>
            <TabList>
              <Tab>Buckets</Tab>
              <Tab>Models</Tab>
              <Tab>Chat</Tab>
              <Tab>Integrate</Tab>
            </TabList>
            <TabPanels>
              <TabPanel>
                <BucketsTab enabled={enabled} />
              </TabPanel>
              <TabPanel>
                <ModelsTab enabled={enabled} />
              </TabPanel>
              <TabPanel>
                <ChatTab enabled={enabled} goToBuckets={goToBuckets} />
              </TabPanel>
              <TabPanel>
                <IntegrateTab enabled={enabled} />
              </TabPanel>
            </TabPanels>
          </Tabs>
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
// Page export
// ---------------------------------------------------------------------------

export function RagPipelinePage() {
  const { states, setStatus } = useAddOnState();
  const state = (states['/rag-pipeline'] ?? 'coming-soon') as PageState;

  if (state === 'active')
    return (
      <RagPipelineView enabled={true} onToggle={() => setStatus('/rag-pipeline', 'disabled')} />
    );
  if (state === 'disabled')
    return (
      <RagPipelineView enabled={false} onToggle={() => setStatus('/rag-pipeline', 'active')} />
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
