/* eslint-disable max-lines */
import { useEffect, useRef, useState } from 'react';
import {
  ChatCircleIcon,
  CubeIcon,
  PaperPlaneTiltIcon,
  ProhibitIcon,
  TerminalIcon,
} from '@phosphor-icons/react/dist/ssr';

import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { CodeBlock } from '../components/CodeBlock.js';
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

function bucketArg(selected: string[]): string {
  if (selected.length === 0 || selected.includes(ALL_BUCKETS_VALUE)) return '*';
  if (selected.length === 1) return selected[0];
  return selected.join(',');
}

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

// ---------------------------------------------------------------------------
// BucketsTab
// ---------------------------------------------------------------------------

function BucketsTab({ enabled }: { enabled: boolean }) {
  return (
    <section className="space-y-4">
      <Heading tag="h2" size="lg">
        Buckets
      </Heading>
      <Card padding="none" className="overflow-hidden">
        {MOCK_BUCKETS.map((b, i) => (
          <div
            key={b.name}
            className={`flex items-center justify-between px-5 py-4 ${i < MOCK_BUCKETS.length - 1 ? 'border-b border-zinc-100' : ''}`}
          >
            <div className="flex items-center gap-3">
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${enabled && b.indexed ? 'bg-green-500' : 'bg-zinc-300'}`}
              />
              <div>
                <p className="text-sm font-medium text-zinc-800">{b.name}</p>
                <p className="text-xs text-zinc-400">
                  {enabled && b.indexed ? `Last synced ${b.lastSynced ?? '—'}` : 'Not indexed'}
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
      {!enabled && (
        <p className="text-sm text-zinc-500">Enable RAG Pipeline to start indexing your buckets.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ModelSection (sub-component used in ModelsTab)
// ---------------------------------------------------------------------------

type ModelSectionProps = {
  icon: React.ReactNode;
  heading: string;
  providerOptions: Array<{ value: string; label: string }>;
  modelOptions: Array<{ value: string; label: string }>;
};

function ModelSection({ icon, heading, providerOptions, modelOptions }: ModelSectionProps) {
  const [provider, setProvider] = useState(providerOptions[0]?.value ?? '');
  const [model, setModel] = useState(modelOptions[0]?.value ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Card padding="md" className="space-y-5">
      <div className="flex items-center gap-2">
        <span className="text-zinc-500">{icon}</span>
        <span className="text-sm font-semibold text-zinc-800">{heading}</span>
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
          <Button variant="ghost" size="md" onClick={handleSave}>
            {saved ? 'Saved ✓' : 'Save'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ModelsTab
// ---------------------------------------------------------------------------

function ModelsTab() {
  return (
    <div className="space-y-10">
      <ModelSection
        icon={<CubeIcon size={18} />}
        heading="Embedding model"
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
      <ModelSection
        icon={<ChatCircleIcon size={18} />}
        heading="Completion model"
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatBucketPicker
// ---------------------------------------------------------------------------

function ChatBucketPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const options = [
    { value: ALL_BUCKETS_VALUE, label: 'All buckets' },
    ...INDEXED_BUCKETS.map((b) => ({ value: b.name, label: b.name })),
  ];

  const selected = options.find((o) => o.value === value) ?? options[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-xs hover:bg-zinc-50"
      >
        {selected?.label}
        <span className="text-zinc-400">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[180px] rounded-lg border border-zinc-200 bg-white py-1 shadow-md">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className="w-full px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
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
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ChatBucketPicker value={chatBucket} onChange={setChatBucket} />
        <Badge color={enabled ? 'blue' : 'amber'} size="sm">
          Test mode
        </Badge>
      </div>

      {!enabled ? (
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <PaperPlaneTiltIcon size={56} className="text-zinc-300" />
          <p className="max-w-xs text-sm text-zinc-500">
            Enable RAG Pipeline to start chatting with your buckets.
          </p>
          <Button variant="primary" size="sm" onClick={goToBuckets}>
            Enable RAG Pipeline
          </Button>
        </div>
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
// BucketDropdown (multi-select with checkboxes)
// ---------------------------------------------------------------------------

function BucketDropdown({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const options = [
    { value: ALL_BUCKETS_VALUE, label: 'All buckets' },
    ...MOCK_BUCKETS.map((b) => ({ value: b.name, label: b.name })),
  ];

  function toggle(value: string) {
    if (value === ALL_BUCKETS_VALUE) {
      onChange(selected.includes(ALL_BUCKETS_VALUE) ? [] : [ALL_BUCKETS_VALUE]);
      return;
    }
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value && v !== ALL_BUCKETS_VALUE)
      : [...selected.filter((v) => v !== ALL_BUCKETS_VALUE), value];
    onChange(next);
  }

  const label =
    selected.length === 0
      ? 'Select buckets'
      : selected.includes(ALL_BUCKETS_VALUE)
        ? 'All buckets'
        : selected.length === 1
          ? (selected[0] ?? 'Select buckets')
          : `${String(selected.length)} buckets`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-xs hover:bg-zinc-50"
      >
        {label}
        <span className="text-zinc-400">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[200px] rounded-lg border border-zinc-200 bg-white py-1 shadow-md">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded border ${selected.includes(opt.value) ? 'border-brand-600 bg-brand-600' : 'border-zinc-300'}`}
              >
                {selected.includes(opt.value) && (
                  <span className="block h-2 w-2 rounded-sm bg-white" />
                )}
              </span>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IntegrateTab
// ---------------------------------------------------------------------------

function IntegrateTab() {
  const [selected, setSelected] = useState<string[]>([ALL_BUCKETS_VALUE]);

  const arg = bucketArg(selected);
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
      <div>
        <Heading tag="h2" size="lg">
          Integrate with your buckets
        </Heading>
        <p className="mt-1 text-sm text-zinc-500">
          Drop RAG Pipeline into your app in a few lines. Pick the buckets you want to query and
          copy the config below.
        </p>
      </div>
      <BucketDropdown selected={selected} onChange={setSelected} />
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge color="grey" size="sm" strength="subtle">
              <TerminalIcon size={12} />
            </Badge>
            <span className="text-sm font-semibold text-zinc-800">MCP endpoint</span>
          </div>
          <CodeBlock code={mcpCode} language="json" />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-800">Query API</span>
          </div>
          <CodeBlock code={queryCode} language="bash" />
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
        { label: 'Files indexed', value: '1,247' },
        { label: 'Index size', value: '324 MB' },
        { label: 'Last synced', value: '1 min ago' },
      ]
    : [
        { label: 'Files indexed', value: '—' },
        { label: 'Index size', value: '—' },
        { label: 'Last synced', value: '—' },
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
                  variant="tertiary"
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
            className={`grid grid-cols-3 gap-3 ${!enabled ? 'pointer-events-none select-none opacity-40' : ''}`}
          >
            {stats.map((s) => (
              <div key={s.label} className="rounded-xl border border-zinc-200 bg-white p-4">
                <p className="mb-1 text-[11px] text-zinc-400">{s.label}</p>
                <p className="text-xl font-semibold text-zinc-900">{s.value}</p>
              </div>
            ))}
          </div>

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
                <ModelsTab />
              </TabPanel>
              <TabPanel>
                <ChatTab enabled={enabled} goToBuckets={goToBuckets} />
              </TabPanel>
              <TabPanel>
                <IntegrateTab />
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
