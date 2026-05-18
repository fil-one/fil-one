/* eslint-disable max-lines, no-unused-vars, complexity/complexity */
import { useState } from 'react';

import {
  CaretRightIcon,
  CheckIcon,
  CodeIcon,
  LightningIcon,
  LockSimpleIcon,
  MagnifyingGlassIcon,
  ProhibitIcon,
  SparkleIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import type { IconBoxColor } from '../components/IconBox.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { Checkbox } from '../components/Checkbox.js';
import { useAddOnState } from '../contexts/addOnState.js';
import {
  useIntegrationState,
  type IntegrationState,
  type IntegrationStatus,
} from '../contexts/integrationState.js';
import { Card } from '../components/Card.js';
import { IconBox } from '../components/IconBox.js';
import { Heading } from '../components/Heading/Heading.js';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../components/Modal/index.js';
import { Switch } from '../components/Switch.js';
import { Tabs, Tab, TabList, TabPanels, TabPanel } from '../components/Tabs/index.js';
import { CodeBlock } from '../components/CodeBlock.js';
import { ComingSoonPage } from '../components/ComingSoonPage.js';

type PageState = 'coming-soon' | 'disabled' | 'active';

// ---------------------------------------------------------------------------
// Product view (active + disabled)
// ---------------------------------------------------------------------------

export type SdkTab = {
  label: string;
  install: string;
  snippet: (bucket: string) => string;
};

export type Archetype = 'paste-config' | 'oauth' | 'install';
export type IntegrationGroup = 'apps' | 'automations' | 'code';

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export type IntegrationDef = {
  initials: string;
  /** simpleicons.org slug used for the brand logo (e.g. "anthropic"). Falls back to initials when omitted. */
  logoSlug?: string;
  name: string;
  subtitle: string;
  archetype: Archetype;
  group: IntegrationGroup;
  configFile?: string;
  configSnippet?: () => string;
  configLanguage?: string;
  sdkTabs?: SdkTab[];
};

export function IntegrationLogo({
  item,
  size = 'sm',
}: {
  item: IntegrationDef;
  size?: 'sm' | 'lg';
}) {
  const isLarge = size === 'lg';
  const containerClass = isLarge
    ? 'h-12 w-12 rounded-lg text-sm'
    : 'h-8 w-8 rounded-md text-[11px]';
  const imgSize = isLarge ? 24 : 16;

  if (item.logoSlug) {
    return (
      <div
        className={`flex flex-shrink-0 items-center justify-center border border-zinc-200 bg-white ${containerClass}`}
      >
        <img
          src={`https://cdn.simpleicons.org/${item.logoSlug}`}
          alt=""
          width={imgSize}
          height={imgSize}
        />
      </div>
    );
  }

  return (
    <div
      className={`flex flex-shrink-0 items-center justify-center bg-zinc-100 font-semibold text-zinc-600 ${containerClass}`}
    >
      {item.initials}
    </div>
  );
}

export const GROUPS: Array<{
  id: IntegrationGroup;
  label: string;
  description: string;
  icon: PhosphorIcon;
  iconColor: IconBoxColor;
}> = [
  {
    id: 'apps',
    label: 'Use in AI apps',
    description:
      'Plug Fil One into AI assistants and chat clients you already use — or any MCP-compatible host.',
    icon: SparkleIcon,
    iconColor: 'blue',
  },
  {
    id: 'automations',
    label: 'Use in automations',
    description:
      'Trigger flows and sync data from no-code workflow builders, or call the API from any HTTP-capable tool.',
    icon: LightningIcon,
    iconColor: 'amber',
  },
  {
    id: 'code',
    label: 'Use in code',
    description:
      'Drop into agent frameworks, use the Fil One SDK, or talk to any S3-compatible client.',
    icon: CodeIcon,
    iconColor: 'green',
  },
];

export const INTEGRATIONS: IntegrationDef[] = [
  // — Apps —
  {
    initials: 'C',
    logoSlug: 'anthropic',
    name: 'Claude Desktop',
    subtitle: "Plug into Claude's MCP host",
    archetype: 'paste-config',
    group: 'apps',
    configFile: '~/Library/Application Support/Claude/claude_desktop_config.json',
  },
  {
    initials: 'Cu',
    logoSlug: 'cursor',
    name: 'Cursor',
    subtitle: "Plug into Cursor's MCP host",
    archetype: 'paste-config',
    group: 'apps',
    configFile: '~/.cursor/mcp.json',
  },
  {
    initials: 'Co',
    name: 'Continue',
    subtitle: "Plug into Continue's MCP host",
    archetype: 'paste-config',
    group: 'apps',
    configFile: '~/.continue/config.json',
  },
  {
    initials: 'Ca',
    logoSlug: 'anthropic',
    name: 'Claude.ai',
    subtitle: 'Authorise Claude.ai with OAuth',
    archetype: 'oauth',
    group: 'apps',
  },
  {
    initials: 'GP',
    logoSlug: 'openai',
    name: 'ChatGPT',
    subtitle: 'Power a Custom GPT with your buckets',
    archetype: 'paste-config',
    group: 'apps',
    configFile: 'Custom GPT → Configure → Actions',
    configLanguage: 'yaml',
    configSnippet: () => `# Paste into the Action's "Schema" field
openapi: 3.1.0
info:
  title: Fil One
  version: '1.0'
servers:
  - url: https://api.fil.one
# Auth: API key, header "Authorization: Bearer sk-live_..."`,
  },
  {
    initials: '+',
    name: 'Other MCP host',
    subtitle: 'For any MCP-compatible client',
    archetype: 'paste-config',
    group: 'apps',
    configFile: "your host's MCP config file",
    configSnippet: () => `// Most MCP hosts accept this same JSON structure
{
  "mcpServers": {
    "filone": {
      "command": "npx",
      "args": ["@filone/mcp-server"],
      "env": { "FILONE_KEY": "sk-live_..." }
    }
  }
}`,
  },
  // — Automations —
  {
    initials: 'Z',
    logoSlug: 'zapier',
    name: 'Zapier',
    subtitle: 'Trigger Zaps from bucket events',
    archetype: 'oauth',
    group: 'automations',
  },
  {
    initials: 'n8',
    logoSlug: 'n8n',
    name: 'n8n',
    subtitle: 'Self-hosted node for workflows',
    archetype: 'install',
    group: 'automations',
    sdkTabs: [
      {
        label: 'Self-hosted',
        install: 'npm install n8n-nodes-filone',
        snippet: () =>
          `// Restart n8n; the Fil One node will appear in your palette.\n// Add a credential with your API key, then drag the node into a workflow.`,
      },
    ],
  },
  {
    initials: 'M',
    logoSlug: 'make',
    name: 'Make.com',
    subtitle: 'Sync buckets with Make scenarios',
    archetype: 'oauth',
    group: 'automations',
  },
  {
    initials: '+',
    name: 'Webhooks & REST',
    subtitle: 'Call from any HTTP-capable tool',
    archetype: 'paste-config',
    group: 'automations',
    configFile: 'your tool of choice',
    configLanguage: 'bash',
    configSnippet: () => `# Trigger Fil One from any tool that can make an HTTP call
curl -X PUT https://api.fil.one/v1/buckets/my-bucket/hello.txt \\
  -H "Authorization: Bearer sk-live_..." \\
  --data-binary @file.txt

# Or subscribe to bucket events via webhooks
# Dashboard → Buckets → Webhooks → Add endpoint`,
  },
  // — Code (works without toolkit enabled) —
  {
    initials: 'LC',
    logoSlug: 'langchain',
    name: 'LangChain',
    subtitle: 'Storage adapter — Python + TS',
    archetype: 'install',
    group: 'code',
    sdkTabs: [
      {
        label: 'Python',
        install: 'pip install filone-langchain',
        snippet: (b) =>
          `from langchain_community.storage import FilOneStore\n\nstore = FilOneStore(\n    bucket="${b}",\n    api_key=os.environ["FILONE_KEY"]\n)`,
      },
      {
        label: 'TypeScript',
        install: 'npm install @filone/langchain',
        snippet: (b) =>
          `import { FilOneStore } from "@filone/langchain";\n\nconst store = new FilOneStore({\n  bucket: "${b}",\n  apiKey: process.env.FILONE_KEY,\n});`,
      },
    ],
  },
  {
    initials: 'LI',
    logoSlug: 'llamaindex',
    name: 'LlamaIndex',
    subtitle: 'Storage backend — Python + TS',
    archetype: 'install',
    group: 'code',
    sdkTabs: [
      {
        label: 'Python',
        install: 'pip install filone-llama-index',
        snippet: (b) =>
          `from llama_index.storage.kvstore.filone import FilOneKVStore\n\nstore = FilOneKVStore(\n    bucket="${b}",\n    api_key=os.environ["FILONE_KEY"]\n)`,
      },
      {
        label: 'TypeScript',
        install: 'npm install @filone/llama-index',
        snippet: (b) =>
          `import { FilOneStorageContext } from "@filone/llama-index";\n\nconst storage = new FilOneStorageContext({\n  bucket: "${b}",\n  apiKey: process.env.FILONE_KEY,\n});`,
      },
    ],
  },
  {
    initials: 'V',
    logoSlug: 'vercel',
    name: 'Vercel AI SDK',
    subtitle: 'Storage for TypeScript apps',
    archetype: 'install',
    group: 'code',
    sdkTabs: [
      {
        label: 'TypeScript',
        install: 'npm install @filone/vercel-ai-sdk',
        snippet: (b) =>
          `import { FilOneStorage } from "@filone/vercel-ai-sdk";\n\nconst storage = new FilOneStorage({\n  bucket: "${b}",\n  apiKey: process.env.FILONE_KEY,\n});`,
      },
    ],
  },
  {
    initials: 'Cr',
    name: 'CrewAI',
    subtitle: 'Tools for Python agents',
    archetype: 'install',
    group: 'code',
    sdkTabs: [
      {
        label: 'Python',
        install: 'pip install filone-crewai',
        snippet: (b) =>
          `from filone_crewai import FilOneTools\n\ntools = FilOneTools(\n    bucket="${b}",\n    api_key=os.environ["FILONE_KEY"]\n)`,
      },
    ],
  },
  {
    initials: 'F1',
    name: 'Fil One SDK',
    subtitle: 'Official SDK — Python + TS',
    archetype: 'install',
    group: 'code',
    sdkTabs: [
      {
        label: 'TypeScript',
        install: 'npm install @filone/agent-toolkit',
        snippet: (b) =>
          `import { FilOne } from "@filone/agent-toolkit";\n\nconst fil = new FilOne({ apiKey: process.env.FILONE_KEY });\nawait fil.bucket("${b}").put(file);`,
      },
      {
        label: 'Python',
        install: 'pip install filone-agent-toolkit',
        snippet: (b) =>
          `from filone import FilOne\n\nfil = FilOne(api_key=os.environ["FILONE_KEY"])\nfil.bucket("${b}").put(file)`,
      },
    ],
  },
  {
    initials: 'S3',
    logoSlug: 'amazons3',
    name: 'S3 API',
    subtitle: 'For any S3-compatible client',
    archetype: 'install',
    group: 'code',
    sdkTabs: [
      {
        label: 'boto3',
        install: 'pip install boto3',
        snippet: (b) =>
          `import boto3\n\ns3 = boto3.client('s3',\n    endpoint_url='https://api.fil.one',\n    aws_access_key_id='YOUR_KEY',\n    aws_secret_access_key='YOUR_SECRET',\n)\ns3.put_object(Bucket="${b}", Key='hello.txt', Body=b'hello')`,
      },
      {
        label: 'aws-sdk',
        install: 'npm install @aws-sdk/client-s3',
        snippet: (b) =>
          `import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";\n\nconst s3 = new S3Client({\n  endpoint: "https://api.fil.one",\n  credentials: { accessKeyId: "YOUR_KEY", secretAccessKey: "YOUR_SECRET" },\n  region: "auto",\n});\nawait s3.send(new PutObjectCommand({ Bucket: "${b}", Key: "hello.txt", Body: "hello" }));`,
      },
    ],
  },
];

export const MOCK_BUCKETS = [
  { name: 'agent-memory', size: '45 MB' },
  { name: 'my-docs-bucket', size: '210 MB' },
  { name: 'research-papers', size: '114 MB' },
  { name: 'contracts-prod', size: '1.2 GB' },
];

export function mcpSnippet(configFile: string) {
  return `// ${configFile.split('/').pop()}
{
  "mcpServers": {
    "filone": {
      "command": "npx",
      "args": ["@filone/mcp-server"],
      "env": { "FILONE_KEY": "sk-live_..." }
    }
  }
}`;
}

function ConnectSdkModal({
  integration,
  open,
  onClose,
  onDone,
}: {
  integration: IntegrationDef;
  open: boolean;
  onClose: () => void;
  onDone: (buckets: string[]) => void;
}) {
  const [step, setStep] = useState<'buckets' | 'code'>('buckets');
  const [selected, setSelected] = useState<string[]>([]);

  function handleClose() {
    setStep('buckets');
    setSelected([]);
    onClose();
  }

  function handleDone() {
    const buckets = selected;
    setStep('buckets');
    setSelected([]);
    onDone(buckets);
  }

  const tabs = integration.sdkTabs ?? [];
  const primaryBucket = selected[0] ?? 'your-bucket';

  return (
    <Modal open={open} onClose={handleClose} size="md">
      {step === 'buckets' ? (
        <>
          <ModalHeader
            onClose={handleClose}
            description="Choose which bucket this integration will read and write."
          >
            Connect {integration.name}
          </ModalHeader>
          <ModalBody>
            <div className="space-y-0.5">
              {MOCK_BUCKETS.map((bucket) => (
                <label
                  key={bucket.name}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-zinc-50"
                >
                  <Checkbox
                    checked={selected.includes(bucket.name)}
                    onChange={(checked) =>
                      setSelected((prev) =>
                        checked ? [...prev, bucket.name] : prev.filter((b) => b !== bucket.name),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900">{bucket.name}</p>
                    <p className="text-xs text-zinc-400">{bucket.size}</p>
                  </div>
                </label>
              ))}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" size="md" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={selected.length === 0}
              onClick={() => setStep('code')}
            >
              Next
            </Button>
          </ModalFooter>
        </>
      ) : (
        <>
          <ModalHeader
            onClose={handleClose}
            description={`Install the package and initialise with your chosen bucket.`}
          >
            Install {integration.name}
          </ModalHeader>
          <ModalBody>
            {tabs.length > 1 ? (
              <Tabs>
                <TabList>
                  {tabs.map((t) => (
                    <Tab key={t.label}>{t.label}</Tab>
                  ))}
                </TabList>
                <TabPanels>
                  {tabs.map((t) => (
                    <TabPanel key={t.label} className="pt-4 space-y-3">
                      <CodeBlock code={t.install} />
                      <CodeBlock code={t.snippet(primaryBucket)} />
                    </TabPanel>
                  ))}
                </TabPanels>
              </Tabs>
            ) : (
              <div className="space-y-3">
                <CodeBlock code={tabs[0]?.install ?? ''} />
                <CodeBlock code={tabs[0]?.snippet(primaryBucket) ?? ''} />
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" size="md" onClick={() => setStep('buckets')}>
              Back
            </Button>
            <Button variant="primary" size="md" onClick={handleDone}>
              Done — I've added this
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

export function ManageBucketsModal({
  integration,
  currentBuckets,
  open,
  onClose,
  onSave,
}: {
  integration: IntegrationDef;
  currentBuckets: string[];
  open: boolean;
  onClose: () => void;
  onSave: (buckets: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(currentBuckets);
  const [mode, setMode] = useState<'all' | 'specific'>(
    currentBuckets.length === 0 ? 'all' : 'specific',
  );

  function handleSave() {
    onSave(mode === 'all' ? [] : selected);
  }

  const rotationNote =
    integration.archetype === 'oauth'
      ? `Saving re-triggers the OAuth flow — you'll need to re-authorise in ${integration.name}.`
      : `Saving rotates the credential. You'll need to update the snippet in ${integration.configFile ?? integration.name} and restart ${integration.name}.`;

  return (
    <Modal open={open} onClose={onClose} size="sm">
      <ModalHeader
        onClose={onClose}
        description="Choose which buckets this integration can read and write."
      >
        Bucket access — {integration.name}
      </ModalHeader>
      <ModalBody>
        <div className="space-y-3">
          <div className="space-y-0.5">
            <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-zinc-50">
              <Checkbox
                checked={mode === 'all'}
                onChange={(checked) => setMode(checked ? 'all' : 'specific')}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900">All buckets</p>
                <p className="text-xs text-zinc-400">Includes any new buckets you create later.</p>
              </div>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-zinc-50">
              <Checkbox
                checked={mode === 'specific'}
                onChange={(checked) => setMode(checked ? 'specific' : 'all')}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900">Specific buckets</p>
                <p className="text-xs text-zinc-400">
                  Pick exactly which buckets this integration can access.
                </p>
              </div>
            </label>
          </div>

          {mode === 'specific' && (
            <div className="rounded-lg border border-zinc-200 bg-white">
              <div className="divide-y divide-zinc-100">
                {MOCK_BUCKETS.map((bucket) => (
                  <label
                    key={bucket.name}
                    className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-zinc-50"
                  >
                    <Checkbox
                      checked={selected.includes(bucket.name)}
                      onChange={(checked) =>
                        setSelected((prev) =>
                          checked ? [...prev, bucket.name] : prev.filter((b) => b !== bucket.name),
                        )
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-zinc-900">{bucket.name}</p>
                      <p className="text-xs text-zinc-400">{bucket.size}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2.5">
            <p className="text-xs leading-relaxed text-amber-800">
              <span className="font-medium">Heads up:</span> {rotationNote}
            </p>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={mode === 'specific' && selected.length === 0}
          onClick={handleSave}
        >
          Save
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ConnectMcpModal({
  integration,
  open,
  onClose,
  onDone,
}: {
  integration: IntegrationDef;
  open: boolean;
  onClose: () => void;
  onDone: (buckets: string[]) => void;
}) {
  const [step, setStep] = useState<'buckets' | 'config'>('buckets');
  const [selected, setSelected] = useState<string[]>([]);

  function handleClose() {
    setStep('buckets');
    setSelected([]);
    onClose();
  }

  function handleDone() {
    const buckets = selected;
    setStep('buckets');
    setSelected([]);
    onDone(buckets);
  }

  const snippet = integration.configSnippet
    ? integration.configSnippet()
    : mcpSnippet(integration.configFile ?? '');
  const language = integration.configLanguage ?? 'json';

  return (
    <Modal open={open} onClose={handleClose} size="sm">
      {step === 'buckets' ? (
        <>
          <ModalHeader
            onClose={handleClose}
            description="Choose which buckets this client can read and write."
          >
            Connect {integration.name}
          </ModalHeader>
          <ModalBody>
            <div className="space-y-0.5">
              {MOCK_BUCKETS.map((bucket) => (
                <label
                  key={bucket.name}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-zinc-50"
                >
                  <Checkbox
                    checked={selected.includes(bucket.name)}
                    onChange={(checked) =>
                      setSelected((prev) =>
                        checked ? [...prev, bucket.name] : prev.filter((b) => b !== bucket.name),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900">{bucket.name}</p>
                    <p className="text-xs text-zinc-400">{bucket.size}</p>
                  </div>
                </label>
              ))}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" size="md" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={selected.length === 0}
              onClick={() => setStep('config')}
            >
              Next
            </Button>
          </ModalFooter>
        </>
      ) : (
        <>
          <ModalHeader onClose={handleClose} description={`Add this to ${integration.configFile}`}>
            Add to your config
          </ModalHeader>
          <ModalBody>
            <CodeBlock code={snippet} language={language} />
            <p className="mt-3 text-xs text-zinc-400">
              Restart {integration.name} after saving the change to take effect.
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" size="md" onClick={() => setStep('buckets')}>
              Back
            </Button>
            <Button variant="primary" size="md" onClick={handleDone}>
              Done — I've added this
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

function ConnectOAuthModal({
  integration,
  open,
  onClose,
  onDone,
}: {
  integration: IntegrationDef;
  open: boolean;
  onClose: () => void;
  onDone: (buckets: string[]) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} size="sm">
      <ModalHeader
        onClose={onClose}
        description={`You'll be redirected to ${integration.name} to authorise access to your Fil One buckets.`}
      >
        Connect {integration.name}
      </ModalHeader>
      <ModalBody>
        <ul className="space-y-2.5 text-sm text-zinc-600">
          <li className="flex items-start gap-2.5">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-zinc-300" />
            Click <span className="font-medium text-zinc-900">Authorise</span> below to open{' '}
            {integration.name} in a new window.
          </li>
          <li className="flex items-start gap-2.5">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-zinc-300" />
            Sign in to {integration.name} and grant access to your Fil One buckets.
          </li>
          <li className="flex items-start gap-2.5">
            <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-zinc-300" />
            You'll be returned here once the connection is complete.
          </li>
        </ul>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="md" onClick={() => onDone([])}>
          Authorise
        </Button>
      </ModalFooter>
    </Modal>
  );
}

type BrowseGroupModalProps = {
  group: (typeof GROUPS)[number];
  items: IntegrationDef[];
  integrationStates: Record<string, IntegrationState>;
  open: boolean;
  onClose: () => void;
  onMarkActive: (name: string, buckets: string[]) => void;
  onDisconnect: (name: string) => void;
};

function BrowseGroupModal({
  group,
  items,
  integrationStates,
  open,
  onClose,
  onMarkActive,
  onDisconnect,
}: BrowseGroupModalProps) {
  const [activeIdx, setActiveIdx] = useState(0);

  function handleClose() {
    setActiveIdx(0);
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} size="lg">
      <ModalHeader onClose={handleClose} description={group.description}>
        <span className="inline-flex items-center gap-2.5">
          <IconBox icon={group.icon} color={group.iconColor} size="sm" />
          {group.label}
        </span>
      </ModalHeader>
      <ModalBody>
        <Tabs defaultIndex={activeIdx} onChange={setActiveIdx}>
          <TabList className="overflow-x-auto">
            {items.map((item) => {
              const status = integrationStates[item.name]?.status ?? 'available';
              return (
                <Tab key={item.name}>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    {item.name}
                    {status === 'connected' && (
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    )}
                    {status === 'pending' && (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    )}
                  </span>
                </Tab>
              );
            })}
          </TabList>
          <TabPanels>
            {items.map((item) => {
              const { status } = integrationStates[item.name] ?? {
                status: 'available',
                buckets: [],
              };
              return (
                <TabPanel key={item.name} className="space-y-4 pt-5">
                  {/* Subtitle + status */}
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-zinc-500">{item.subtitle}</p>
                    <div className="flex items-center gap-2">
                      {status === 'connected' && (
                        <>
                          <Badge color="green" size="sm" strength="strong">
                            Connected
                          </Badge>
                          <Button
                            variant="tertiary"
                            size="sm"
                            onClick={() => onDisconnect(item.name)}
                          >
                            Disconnect
                          </Button>
                        </>
                      )}
                      {status === 'pending' && (
                        <Badge color="amber" size="sm" strength="strong">
                          Pending
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Archetype body */}
                  {item.archetype === 'install' && <InstallBody item={item} />}
                  {item.archetype === 'paste-config' && <PasteConfigBody item={item} />}
                  {item.archetype === 'oauth' && <OAuthBody item={item} />}

                  {/* Action — only when not already active */}
                  {status === 'available' && (
                    <div className="flex justify-end">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => onMarkActive(item.name, [])}
                      >
                        {item.archetype === 'install'
                          ? "Done — I've installed it"
                          : item.archetype === 'paste-config'
                            ? "Done — I've added this"
                            : `Authorise with ${item.name}`}
                      </Button>
                    </div>
                  )}
                </TabPanel>
              );
            })}
          </TabPanels>
        </Tabs>
      </ModalBody>
    </Modal>
  );
}

export function InstallBody({
  item,
  showHint = false,
}: {
  item: IntegrationDef;
  showHint?: boolean;
}) {
  const tabs = item.sdkTabs ?? [];
  const sampleBucket = 'your-bucket';
  const body =
    tabs.length > 1 ? (
      <Tabs>
        <TabList>
          {tabs.map((t) => (
            <Tab key={t.label}>{t.label}</Tab>
          ))}
        </TabList>
        <TabPanels>
          {tabs.map((t) => (
            <TabPanel key={t.label} className="space-y-3 pt-3">
              <CodeBlock code={t.install} />
              <CodeBlock code={t.snippet(sampleBucket)} />
            </TabPanel>
          ))}
        </TabPanels>
      </Tabs>
    ) : (
      <div className="space-y-3">
        <CodeBlock code={tabs[0]?.install ?? ''} />
        <CodeBlock code={tabs[0]?.snippet(sampleBucket) ?? ''} />
      </div>
    );
  return (
    <div className="space-y-3">
      {body}
      {showHint && (
        <p className="text-xs text-zinc-400">
          We'll mark this as connected once we see your first request.
        </p>
      )}
    </div>
  );
}

export function PasteConfigBody({
  item,
  showHint = false,
}: {
  item: IntegrationDef;
  showHint?: boolean;
}) {
  const snippet = item.configSnippet ? item.configSnippet() : mcpSnippet(item.configFile ?? '');
  const language = item.configLanguage ?? 'json';
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Add this to{' '}
        <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700">
          {item.configFile}
        </code>
        .
      </p>
      <CodeBlock code={snippet} language={language} />
      <p className="text-xs text-zinc-400">
        Restart {item.name} after saving for the change to take effect.
      </p>
      {showHint && (
        <p className="text-xs text-zinc-400">
          We'll mark this as connected once we see your first request.
        </p>
      )}
    </div>
  );
}

export function OAuthBody({
  item,
  showAction = false,
  onAuthorise,
}: {
  item: IntegrationDef;
  showAction?: boolean;
  onAuthorise?: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600">
        You'll be redirected to {item.name} to authorise access to your Fil One buckets. You can
        scope which buckets are visible during the consent step.
      </p>
      {showAction && (
        <div>
          <Button variant="primary" size="md" onClick={onAuthorise}>
            Authorise with {item.name}
          </Button>
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line max-lines-per-function
function AiAgentToolkitProductView({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  const { states: integrationStates } = useIntegrationState();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [query, setQuery] = useState('');

  const stats = enabled
    ? [
        { label: 'API requests', value: '42,318', sub: 'this month' },
        { label: 'Last Active', value: '2 min ago', sub: 'last request' },
        { label: 'Est. Cost', value: '$2.12', sub: '$0.05 / 1k requests' },
      ]
    : [
        { label: 'API requests', value: '—', sub: 'Available once enabled' },
        { label: 'Last Active', value: '—', sub: 'Available once enabled' },
        { label: 'Est. Cost', value: '—', sub: 'Available once enabled' },
      ];

  const activeItems = INTEGRATIONS.filter((i) => {
    const s = integrationStates[i.name]?.status;
    return s === 'connected' || s === 'pending';
  });

  const GROUP_LABELS: Record<IntegrationGroup, string> = {
    apps: 'AI apps',
    automations: 'Automations',
    code: 'Developer SDKs',
  };

  const filteredIntegrations = INTEGRATIONS.filter((i) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return i.name.toLowerCase().includes(q) || i.subtitle.toLowerCase().includes(q);
  });

  const groupedFiltered = GROUPS.map((g) => ({
    ...g,
    items: filteredIntegrations.filter((i) => i.group === g.id),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <div className="px-10 py-12 pb-20 max-w-4xl">
        {/* Header */}
        <div className="mb-10 flex items-start justify-between gap-6">
          <Heading
            tag="h1"
            size="2xl"
            description="Connect AI assistants, automation tools, and your code to Fil One buckets."
          >
            <span className="inline-flex items-center gap-2.5">
              AI Agent Toolkit
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
          <div className="mt-1 flex flex-shrink-0 items-center gap-2.5">
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
                Enable AI Agent Toolkit
              </Button>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className={`mb-10 grid grid-cols-3 gap-3 ${!enabled ? 'opacity-60' : ''}`}>
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

        {/* Integration management */}
        <div>
          {/* Connected */}
          {enabled && activeItems.length > 0 && (
            <section className="mb-10">
              <p className="mb-3 text-sm font-medium text-zinc-900">Connected</p>
              <Card padding="none" className="overflow-hidden divide-y divide-zinc-100">
                {activeItems.map((item) => {
                  const { status, buckets } = integrationStates[item.name]!;
                  return (
                    <Link
                      key={item.name}
                      to="/ai-agent-toolkit/integrations/$slug"
                      params={{ slug: slugify(item.name) }}
                      className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-zinc-50"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <IntegrationLogo item={item} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-zinc-900">{item.name}</p>
                            {status === 'pending' && (
                              <Badge color="amber" size="sm" strength="strong">
                                Pending
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-zinc-400">
                            {buckets.length === 0 ? (
                              <span className="text-zinc-500">All buckets</span>
                            ) : (
                              <>
                                <span className="text-zinc-500">{buckets.length}</span>{' '}
                                {buckets.length === 1 ? 'bucket' : 'buckets'}
                              </>
                            )}
                            {status === 'connected' && (
                              <>
                                <span aria-hidden="true"> · </span>
                                <span className="text-zinc-500">1,247</span> requests this month
                                <span aria-hidden="true"> · </span>
                                Active <span className="text-zinc-500">2 min ago</span>
                              </>
                            )}
                            {status === 'pending' && (
                              <>
                                <span aria-hidden="true"> · </span>
                                Waiting for first request
                              </>
                            )}
                          </p>
                        </div>
                      </div>
                      <CaretRightIcon
                        size={14}
                        weight="bold"
                        className="flex-shrink-0 text-zinc-300"
                      />
                    </Link>
                  );
                })}
              </Card>
            </section>
          )}

          {/* All integrations */}
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-zinc-900">All integrations</p>
              <div className="relative w-64">
                <MagnifyingGlassIcon
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
                />
                <input
                  type="search"
                  placeholder="Search…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full rounded-md border border-(--input-border-color) bg-white py-2 pl-8 pr-3 text-sm text-(--color-text-base) placeholder:text-(--input-placeholder-color) focus-visible:brand-outline"
                />
              </div>
            </div>

            {!enabled && (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
                <p className="text-sm text-zinc-600">
                  Enable the AI Agent Toolkit to connect AI apps and automations.
                </p>
                <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
                  Enable
                </Button>
              </div>
            )}

            <Card padding="none" className="overflow-hidden">
              {groupedFiltered.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-zinc-400">
                  No integrations match "{query}"
                </div>
              ) : (
                groupedFiltered.map((group, gi) => {
                  const isDocsGroup = group.id === 'code';
                  return (
                    <div key={group.id} className={gi > 0 ? 'border-t border-zinc-100' : ''}>
                      <div className="bg-zinc-50/60 px-5 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                          {GROUP_LABELS[group.id]}
                        </p>
                        {isDocsGroup && (
                          <p className="mt-0.5 text-xs text-zinc-400">
                            Works with any Fil One API key — no toolkit required.
                          </p>
                        )}
                      </div>
                      <div className="divide-y divide-zinc-100">
                        {group.items.map((item) => {
                          const status = integrationStates[item.name]?.status ?? 'available';
                          const isInteractive = enabled || isDocsGroup;
                          const showRightSlot = isInteractive;
                          const rowChildren = (
                            <>
                              <IntegrationLogo item={item} />
                              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <p className="truncate text-sm font-medium text-zinc-900">
                                  {item.name}
                                </p>
                                <p className="truncate text-xs text-zinc-400">{item.subtitle}</p>
                              </div>
                              {showRightSlot && (
                                <div className="flex flex-shrink-0 items-center gap-2.5">
                                  {!isDocsGroup && status === 'connected' && (
                                    <Badge color="green" size="sm" strength="strong">
                                      Connected
                                    </Badge>
                                  )}
                                  {!isDocsGroup && status === 'pending' && (
                                    <Badge color="amber" size="sm" strength="strong">
                                      Pending
                                    </Badge>
                                  )}
                                  <CaretRightIcon
                                    size={14}
                                    weight="bold"
                                    className="text-zinc-300"
                                  />
                                </div>
                              )}
                            </>
                          );
                          return isInteractive ? (
                            <Link
                              key={item.name}
                              to="/ai-agent-toolkit/integrations/$slug"
                              params={{ slug: slugify(item.name) }}
                              className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-zinc-50"
                            >
                              {rowChildren}
                            </Link>
                          ) : (
                            <div
                              key={item.name}
                              className="flex w-full cursor-default select-none items-center gap-3 px-5 py-4 text-left opacity-60"
                            >
                              {rowChildren}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </Card>
          </section>
        </div>
      </div>

      {/* Toggle confirmation */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} size="sm">
        <ModalHeader onClose={() => setConfirmOpen(false)}>
          {enabled ? 'Disable AI Agent Toolkit?' : 'Enable AI Agent Toolkit?'}
        </ModalHeader>
        <ModalBody>
          {enabled ? (
            <p className="text-sm text-zinc-600">
              Your MCP endpoint and workflow connectors will be deactivated. Existing data in your
              buckets is not affected.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
                <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                  Pricing
                </p>
                <div className="space-y-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-zinc-600">Per 1,000 API requests</span>
                    <span className="text-sm font-semibold text-zinc-900">$0.05</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-zinc-600">Bucket storage</span>
                    <span className="text-sm font-semibold text-zinc-900">Standard rate</span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-zinc-500">
                Billed monthly on your Fil One invoice. No setup fee. Disable at any time.
              </p>
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="md" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            variant={enabled ? 'destructive' : 'primary'}
            size="md"
            onClick={() => {
              setConfirmOpen(false);
              onToggle();
            }}
          >
            {enabled ? 'Disable' : 'Enable'}
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AiAgentToolkitPage() {
  const { states, setStatus } = useAddOnState();
  const state = (states['/ai-agent-toolkit'] ?? 'coming-soon') as PageState;

  if (state === 'active')
    return (
      <AiAgentToolkitProductView
        enabled={true}
        onToggle={() => setStatus('/ai-agent-toolkit', 'disabled')}
      />
    );
  if (state === 'disabled')
    return (
      <AiAgentToolkitProductView
        enabled={false}
        onToggle={() => setStatus('/ai-agent-toolkit', 'active')}
      />
    );

  return (
    <ComingSoonPage
      title="AI Agent Toolkit"
      description="Plug Fil One into AI assistants, MCP clients, and automation tools."
      what="The AI Agent Toolkit makes Fil One's decentralized storage natively accessible to AI assistants and automation platforms. Connect Claude Desktop, Cursor, or any MCP-compatible host with a single config block. Authorise Claude.ai, Zapier, or Make.com via OAuth. Trigger workflows from bucket events with webhooks — all without writing custom backend code."
      features={[
        {
          category: 'Integrations',
          title: 'MCP Server',
          description:
            'A native Model Context Protocol server you can plug directly into Claude, Cursor, and any MCP-compatible host. Exposes read, write, list, and delete as tools.',
        },
        {
          category: 'Connectors',
          title: 'OAuth-ready apps',
          description:
            'One-click authorisation for Claude.ai, Zapier, and Make.com. Scope bucket access during consent and revoke any time.',
        },
        {
          category: 'Storage',
          title: 'Agent memory',
          description:
            'Store and retrieve conversation history, task state, and long-term context. Structured as JSON or raw blobs — your agent decides the schema.',
        },
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
          title: 'Sync buckets to Zapier',
          description:
            'Trigger Zaps when files land in a bucket or push records out to thousands of other apps via Zapier.',
        },
        {
          category: 'Multi-agent systems',
          title: 'Shared context store',
          description:
            'Multiple agents read and write a shared bucket for coordination without a separate state management layer.',
        },
      ]}
      whyFilOne={[
        {
          title: 'Data sovereignty',
          description:
            'Your agent data lives in your Fil One buckets — not a third-party SaaS. You own the keys, you own the data.',
        },
        {
          title: 'Cost efficiency',
          description:
            'Pay only for what your agents actually use. No minimum commit, no per-seat pricing, no hidden egress surprises.',
        },
        {
          title: 'Verifiable storage',
          description:
            'Every write is cryptographically verified on the Filecoin network. Ideal for audit trails and agent accountability.',
        },
        {
          title: 'No infrastructure to manage',
          description:
            'Fil One handles durability, redundancy, and scaling. Your team ships agents, not ops runbooks.',
        },
      ]}
      pricing={{
        headline: 'Usage-based add-on',
        subline:
          'Metered separately, billed alongside your Fil One storage. Rates published before launch.',
        inclusions: [
          'Pay only for what you use',
          'No egress fees',
          'Billed on your existing Fil One invoice',
          'Waitlist members get early-access rates',
        ],
      }}
      interestForm={{
        workloadLabel: 'Primary use case',
        workloadTypes: [
          'AI assistants (Claude, Cursor)',
          'Custom GPTs / connectors',
          'No-code automations',
          'Agent memory / context',
          'Other',
        ],
        providers: [
          'Claude Desktop',
          'Cursor',
          'Continue',
          'ChatGPT',
          'Zapier',
          'Make.com',
          'Custom',
          'Other',
        ],
        timelines: [
          'Actively building now',
          'Planning in next 3 months',
          'Evaluating in next 6 months',
          'Just exploring',
        ],
        notesPlaceholder:
          'What are you building? Which AI app or automation tool are you connecting?',
      }}
      faqs={[
        {
          question: 'What is MCP?',
          answer:
            'Model Context Protocol is an open standard developed by Anthropic for connecting AI assistants to external data sources and tools. It lets hosts like Claude Desktop discover and call tools exposed by MCP servers.',
        },
        {
          question: 'Which apps are supported at launch?',
          answer:
            'Claude Desktop, Cursor, and Continue via local MCP. Claude.ai, Zapier, and Make.com via OAuth. ChatGPT via Custom GPT Actions. Any MCP-compatible host or HTTP-capable tool also works directly.',
        },
        {
          question: 'Is my agent data private?',
          answer:
            'Yes. Fil One supports private buckets with access controls. Only your API keys can read or write your agent data unless you explicitly grant access.',
        },
        {
          question: 'Can I use this with Claude?',
          answer:
            'Yes — the MCP server works natively with Claude Desktop and any MCP-compatible host. Add your Fil One credentials to your MCP config and you are ready to go.',
        },
        {
          question: 'Do I need the toolkit to use Fil One in code?',
          answer:
            'No. Code-level access through SDKs or the raw S3 API uses your existing Fil One credentials — no toolkit required. This add-on is specifically for connecting AI apps and no-code automation tools.',
        },
      ]}
      onEnable={() => setStatus('/ai-agent-toolkit', 'disabled')}
    />
  );
}
