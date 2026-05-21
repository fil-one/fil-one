/* eslint-disable max-lines */
import { useEffect, useRef, useState } from 'react';
import {
  CaretDownIcon,
  ChatCircleIcon,
  CheckIcon,
  CubeIcon,
  DotsThreeIcon,
  LightningIcon,
  ProhibitIcon,
  TerminalIcon,
  XIcon,
} from '@phosphor-icons/react/dist/ssr';

import { Alert } from '../components/Alert.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { CodeBlock } from '../components/CodeBlock.js';
import { Heading } from '../components/Heading/Heading.js';
import { Input } from '../components/Input.js';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal/index.js';
import { Select } from '../components/Select.js';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '../components/Tabs/index.js';
import { Link } from '@tanstack/react-router';
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

type QueryResult = {
  answer: string;
  sources: Array<{ file: string; excerpt: string }>;
};

const MOCK_QUERY_RESULT: QueryResult = {
  answer:
    'The default retention period is 90 days for standard objects. Compliance-tagged items are subject to extended retention as outlined in the data governance guide.',
  sources: [
    {
      file: 'my-docs-bucket/policies/data-retention.pdf',
      excerpt:
        '…the standard retention period shall not exceed 90 calendar days from the date of creation…',
    },
    {
      file: 'research-papers/governance-whitepaper.pdf',
      excerpt:
        '…compliance-tagged documents require a minimum retention of 12 months under applicable regulations…',
    },
  ],
};

type HistoryEntry = {
  id: string;
  question: string;
  answer: string;
  sources: Array<{ file: string }>;
  timestamp: string;
};

const MOCK_HISTORY: HistoryEntry[] = [
  {
    id: '1',
    question: 'What is the default retention period for standard objects?',
    answer:
      'The default retention period is 90 days for standard objects. Compliance-tagged items are subject to extended retention as outlined in the data governance guide.',
    sources: [{ file: 'policies/data-retention.pdf' }, { file: 'governance-whitepaper.pdf' }],
    timestamp: '2 hours ago',
  },
  {
    id: '2',
    question: 'Are compliance-tagged documents subject to different rules?',
    answer:
      'Yes. Compliance-tagged documents require a minimum retention of 12 months under applicable regulations, regardless of the standard 90-day policy.',
    sources: [{ file: 'governance-whitepaper.pdf' }],
    timestamp: 'Yesterday',
  },
  {
    id: '3',
    question: 'Which file formats are supported for indexing?',
    answer:
      'PDF, Markdown, plain text, HTML, and DOCX are supported. Additional formats including CSV and PowerPoint are on the roadmap.',
    sources: [{ file: 'docs/supported-formats.md' }],
    timestamp: '3 days ago',
  },
];

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
// BucketActionMenu
// ---------------------------------------------------------------------------

function BucketActionMenu({ onDisable }: { onDisable: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function handleOpen() {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((o) => !o);
  }

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Bucket actions"
        onClick={handleOpen}
        className="rounded p-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
      >
        <DotsThreeIcon weight="bold" width={18} height={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menuRef}
          style={{ top: pos.top, right: pos.right }}
          className="fixed z-50 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onDisable();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            <ProhibitIcon size={14} />
            Disable
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HistoryItem
// ---------------------------------------------------------------------------

function HistoryItem({ item, isLast }: { item: HistoryEntry; isLast: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={!isLast ? 'border-b border-zinc-100' : ''}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 py-3 text-left"
      >
        <p className="text-xs font-medium text-zinc-700">{item.question}</p>
        <CaretDownIcon
          size={12}
          weight="bold"
          className={`flex-shrink-0 text-zinc-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="pb-3 space-y-1.5">
          <p className="text-xs leading-relaxed text-zinc-500">{item.answer}</p>
          <p className="text-[10px] text-zinc-400">
            {item.timestamp}
            {item.sources.length > 0 && (
              <>
                <span aria-hidden="true"> · </span>
                {item.sources.length} source{item.sources.length !== 1 ? 's' : ''}
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BucketDrawer
// ---------------------------------------------------------------------------

function BucketDrawer({
  bucket,
  onClose,
}: {
  bucket: (typeof MOCK_BUCKETS)[0];
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [question, setQuestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  function handleClose() {
    setClosing(true);
    setTimeout(onClose, 200);
  }

  function handleAsk() {
    if (!input.trim()) return;
    setQuestion(input.trim());
    setResult(null);
    setLoading(true);
    setInput('');
    setTimeout(() => {
      setLoading(false);
      setResult(MOCK_QUERY_RESULT);
    }, 1400);
  }

  const shown = visible && !closing;

  return (
    <>
      <div
        className={`fixed inset-0 z-30 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
      />
      <div
        className={`fixed inset-y-0 right-0 z-40 flex w-[460px] flex-col border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-200 ease-out ${shown ? 'translate-x-0' : 'translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-sm font-semibold text-zinc-900">{bucket.name}</span>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
          >
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex flex-shrink-0 items-center gap-4 border-b border-zinc-100 bg-zinc-50/60 px-5 py-2.5 text-xs text-zinc-500">
          <span>
            <span className="font-medium text-zinc-800">{bucket.files.toLocaleString()}</span> files
          </span>
          <span className="text-zinc-300">·</span>
          <span className="font-medium text-zinc-800">{bucket.size}</span>
          {bucket.lastSynced && (
            <>
              <span className="text-zinc-300">·</span>
              <span>
                Last synced <span className="font-medium text-zinc-800">{bucket.lastSynced}</span>
              </span>
            </>
          )}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          {/* Ask section */}
          <div className="px-5 py-5">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
              Ask a question
            </p>
            <div className="flex gap-2">
              <Input
                placeholder={`Ask about ${bucket.name}…`}
                value={input}
                onChange={setInput}
                className="flex-1"
              />
              <Button variant="primary" size="sm" disabled={!input.trim()} onClick={handleAsk}>
                Ask
              </Button>
            </div>
            {(loading || result) && (
              <div className="mt-4 rounded-lg border border-zinc-100 bg-zinc-50/50 p-4">
                {question && <p className="mb-3 text-xs italic text-zinc-400">"{question}"</p>}
                {loading ? (
                  <div className="space-y-2.5">
                    <div className="h-2 w-3/4 animate-pulse rounded-full bg-zinc-200" />
                    <div className="h-2 w-full animate-pulse rounded-full bg-zinc-200" />
                    <div className="h-2 w-5/6 animate-pulse rounded-full bg-zinc-200" />
                    <div className="h-2 w-2/3 animate-pulse rounded-full bg-zinc-200" />
                  </div>
                ) : (
                  result && (
                    <>
                      <p className="text-sm leading-relaxed text-zinc-700">{result.answer}</p>
                      {result.sources.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-zinc-100 pt-3">
                          {result.sources.map((source) => {
                            const slash = source.file.indexOf('/');
                            const bucketName =
                              slash !== -1 ? source.file.slice(0, slash) : source.file;
                            const key = slash !== -1 ? source.file.slice(slash + 1) : '';
                            const filename = source.file.split('/').pop() ?? source.file;
                            return (
                              <Link
                                key={source.file}
                                to="/buckets/$bucketName/objects"
                                params={{ bucketName }}
                                search={{ key }}
                                title={source.file}
                                className="inline-flex items-center rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-[11px] text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900"
                              >
                                {filename}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )
                )}
              </div>
            )}
          </div>

          {/* History section */}
          <div className="border-t border-zinc-100 px-5 py-5">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
              History
            </p>
            <div>
              {MOCK_HISTORY.map((item, i) => (
                <HistoryItem key={item.id} item={item} isLast={i === MOCK_HISTORY.length - 1} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// BucketsTab
// ---------------------------------------------------------------------------

function BucketsTab({ enabled }: { enabled: boolean }) {
  const [buckets, setBuckets] = useState(MOCK_BUCKETS);
  const [activeDrawer, setActiveDrawer] = useState<string | null>(null);
  const activeBucket = buckets.find((b) => b.name === activeDrawer) ?? null;

  function handleIndex(name: string) {
    setBuckets((prev) =>
      prev.map((b) => (b.name === name ? { ...b, indexed: true, lastSynced: 'just now' } : b)),
    );
  }

  return (
    <section className="space-y-6">
      <Heading
        tag="h2"
        size="lg"
        description="Manage which buckets are indexed and available for querying."
      >
        Buckets
      </Heading>
      <div className="space-y-3">
        {buckets.map((b) => (
          <Card key={b.name} padding="none" className="overflow-hidden">
            <div
              className={`flex items-center justify-between px-5 py-4${!enabled ? ' opacity-60' : ''}`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${enabled && b.indexed ? 'bg-green-500' : 'bg-zinc-300'}`}
                />
                <div>
                  <p className="text-sm font-medium text-zinc-800">{b.name}</p>
                  <p className="text-xs text-zinc-400">
                    {b.indexed && enabled ? (
                      <>
                        <span className="text-zinc-500">{b.files.toLocaleString()}</span>
                        {' files indexed'}
                        <span aria-hidden="true"> · </span>
                        <span className="text-zinc-500">{b.size}</span>
                        <span aria-hidden="true"> · </span>
                        {'Last synced '}
                        <span className="text-zinc-500">{b.lastSynced ?? '—'}</span>
                      </>
                    ) : (
                      <>
                        <span className="text-zinc-500">{b.files.toLocaleString()}</span>
                        {' files'}
                        <span aria-hidden="true"> · </span>
                        <span className="text-zinc-500">{b.size}</span>
                        <span aria-hidden="true"> · </span>
                        {'Not indexed'}
                      </>
                    )}
                  </p>
                </div>
              </div>
              {enabled && (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  {b.indexed ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setActiveDrawer(b.name)}>
                        Ask questions
                      </Button>
                      <BucketActionMenu onDisable={() => {}} />
                    </>
                  ) : (
                    <Button variant="primary" size="sm" onClick={() => handleIndex(b.name)}>
                      Index
                    </Button>
                  )}
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
      {activeBucket && enabled && (
        <BucketDrawer bucket={activeBucket} onClose={() => setActiveDrawer(null)} />
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
  description: string;
  providerOptions: Array<{ value: string; label: string }>;
  providerModels: Record<string, Array<{ value: string; label: string }>>;
};

function ModelSection({
  icon,
  heading,
  description,
  providerOptions,
  providerModels,
}: ModelSectionProps) {
  const [provider, setProvider] = useState(providerOptions[0]?.value ?? '');
  const modelOptions = providerModels[provider] ?? [];
  const [model, setModel] = useState(modelOptions[0]?.value ?? '');

  function handleProviderChange(next: string) {
    setProvider(next);
    const nextModels = providerModels[next] ?? [];
    setModel(nextModels[0]?.value ?? '');
  }
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
        <Select value={provider} onChange={handleProviderChange}>
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
              { value: 'voyage', label: 'Voyage' },
            ]}
            providerModels={{
              openai: [
                { value: 'text-embedding-3-small', label: 'text-embedding-3-small' },
                { value: 'text-embedding-3-large', label: 'text-embedding-3-large' },
              ],
              voyage: [{ value: 'voyage-3', label: 'voyage-3' }],
            }}
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
            ]}
            providerModels={{
              openai: [
                { value: 'gpt-4o', label: 'gpt-4o' },
                { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
              ],
              anthropic: [
                { value: 'claude-3-7-sonnet-20250219', label: 'claude-3-7-sonnet-20250219' },
              ],
            }}
          />
        </Card>
      </div>
    </div>
  );
}

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

  const stats = enabled
    ? [
        { label: 'Files indexed', value: '1,247', sub: 'across all buckets' },
        { label: 'Index size', value: '324 MB', sub: 'total storage used' },
        {
          label: 'Est. cost',
          value: '$4.86',
          sub: '$15 / TB / month · LLM provider fees not included',
        },
      ]
    : [
        { label: 'Files indexed', value: '—', sub: 'Available once enabled' },
        { label: 'Index size', value: '—', sub: 'Available once enabled' },
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
                  ? 'Turn any bucket into a queryable knowledge base.'
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
            className={`grid grid-cols-3 gap-3 ${!enabled ? 'pointer-events-none select-none opacity-60' : ''}`}
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

          <Tabs>
            <TabList>
              <Tab>Buckets</Tab>
              <Tab>Models</Tab>
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
