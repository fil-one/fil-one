import { useState } from 'react';

import { KeyIcon, PlusIcon, PowerIcon, TrashIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from '@hyperspace/ui/Button';
import { CodeBlock } from '@hyperspace/ui/CodeBlock';
import { Input } from '@hyperspace/ui/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@hyperspace/ui/Modal';
import { Tab, TabList, TabPanel, TabPanels, Tabs } from '@hyperspace/ui/Tabs';
import { useToast } from '@hyperspace/ui/Toast';

import type { AccessKey } from '@hyperspace/shared';

import { S3_ENDPOINT } from '../../env';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_KEYS: AccessKey[] = [
  {
    id: '1',
    name: 'Production',
    accessKeyId: 'HKIAXXXXXXXXXXX1ABCD',
    createdAt: '2024-01-15T10:00:00Z',
    lastUsedAt: '2024-02-15T10:00:00Z',
    status: 'active',
  },
  {
    id: '2',
    name: 'Local dev',
    accessKeyId: 'HKIAXXXXXXXXXXX2EFGH',
    createdAt: '2024-02-01T09:00:00Z',
    lastUsedAt: undefined,
    status: 'inactive',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: AccessKey['status'] }) {
  if (status === 'active') {
    return (
      <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
        Active
      </span>
    );
  }

  return (
    <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
      Inactive
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: Access Keys
// ---------------------------------------------------------------------------

type AccessKeysTabProps = {
  keys: AccessKey[];
  onCreateOpen: () => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
};

function AccessKeysTab({ keys, onCreateOpen, onToggle, onDelete }: AccessKeysTabProps) {
  return (
    <>
      {/* Action bar */}
      <div className="mt-4 mb-4 flex items-center justify-between">
        <span className="text-sm text-zinc-600">{keys.length} keys</span>
        <Button variant="filled" icon={PlusIcon} onClick={onCreateOpen}>
          Create access key
        </Button>
      </div>

      {keys.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-200 bg-white py-16">
          <KeyIcon size={40} className="mb-3 text-zinc-300" />
          <p className="mb-1 text-sm font-medium text-zinc-900">No access keys</p>
          <p className="mb-4 text-sm text-zinc-500">Create an access key to connect via S3 API</p>
          <Button variant="filled" icon={PlusIcon} onClick={onCreateOpen}>
            Create access key
          </Button>
        </div>
      ) : (
        /* Keys table */
        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="min-w-full">
            <thead>
              <tr>
                <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Name
                </th>
                <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Access Key ID
                </th>
                <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Created
                </th>
                <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Last Used
                </th>
                <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Status
                </th>
                <th className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr
                  key={key.id}
                  className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                >
                  <td className="px-4 py-3 text-sm font-medium text-zinc-900">{key.name}</td>
                  <td className="px-4 py-3 font-mono text-sm text-zinc-700">{key.accessKeyId}</td>
                  <td className="px-4 py-3 text-sm text-zinc-600">{formatDate(key.createdAt)}</td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    {key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    <StatusBadge status={key.status} />
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-600">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onToggle(key.id)}
                        aria-label={key.status === 'active' ? 'Deactivate key' : 'Activate key'}
                        className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                        title={key.status === 'active' ? 'Deactivate' : 'Activate'}
                      >
                        <PowerIcon size={16} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(key.id)}
                        aria-label="Delete key"
                        className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-red-500"
                        title="Delete"
                      >
                        <TrashIcon size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Connection Details
// ---------------------------------------------------------------------------

function ConnectionDetailsTab() {
  return (
    <div className="mt-4 flex flex-col gap-6">
      {/* Endpoint */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900">S3 Endpoint</h3>
        <CodeBlock code={S3_ENDPOINT} language="URL" />
      </div>

      {/* Region */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900">Region</h3>
        {/* UNKNOWN: confirm whether us-east-1 is the correct/only region */}
        <CodeBlock code="us-east-1" language="Region" />
      </div>

      {/* AWS CLI config */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900">AWS CLI Configuration</h3>
        <p className="mb-2 text-sm text-zinc-600">
          Add to your <code className="rounded bg-zinc-100 px-1 text-xs">~/.aws/config</code>:
        </p>
        <CodeBlock
          language="INI"
          code={`[profile hyperspace]\nendpoint_url = ${S3_ENDPOINT}\nregion = us-east-1`}
        />
      </div>

      {/* SDK example */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900">JavaScript / AWS SDK v3</h3>
        <CodeBlock
          language="JavaScript"
          code={`import { S3Client } from '@aws-sdk/client-s3'\n\nconst client = new S3Client({\n  endpoint: '${S3_ENDPOINT}',\n  region: 'us-east-1',\n  credentials: {\n    accessKeyId: 'YOUR_ACCESS_KEY_ID',\n    secretAccessKey: 'YOUR_SECRET_ACCESS_KEY',\n  },\n})`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Access Key Modal
// ---------------------------------------------------------------------------

type CreateKeyModalProps = {
  open: boolean;
  onClose: () => void;
  keys: AccessKey[];
  createStep: 'form' | 'credentials';
  newKeyName: string;
  newSecretKey: string;
  onNameChange: (value: string) => void;
  onCreateKey: () => void;
  onDone: () => void;
};

function CreateKeyModal({
  open,
  onClose,
  keys,
  createStep,
  newKeyName,
  newSecretKey,
  onNameChange,
  onCreateKey,
  onDone,
}: CreateKeyModalProps) {
  if (createStep === 'form') {
    return (
      <Modal open={open} onClose={onClose} size="sm">
        <ModalHeader onClose={onClose}>Create access key</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700">Key name</label>
            <Input
              value={newKeyName}
              onChange={onNameChange}
              placeholder="e.g. Production, Local dev"
            />
            <p className="text-xs text-zinc-500">
              A descriptive name to identify where this key is used.
            </p>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="filled" disabled={!newKeyName.trim()} onClick={onCreateKey}>
              Create key
            </Button>
          </div>
        </ModalFooter>
      </Modal>
    );
  }

  // Step: credentials
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader>Save your credentials</ModalHeader>
      <ModalBody>
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          ⚠️ This is the only time you&apos;ll be able to see the secret access key. Copy it now.
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
              Access Key ID
            </p>
            <CodeBlock code={keys[keys.length - 1]?.accessKeyId ?? ''} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
              Secret Access Key
            </p>
            <CodeBlock code={newSecretKey} />
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex justify-end">
          <Button variant="filled" onClick={onDone}>
            I&apos;ve saved my credentials
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ApiKeysPage() {
  const { toast } = useToast();

  const [keys, setKeys] = useState<AccessKey[]>(MOCK_KEYS);

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState<'form' | 'credentials'>('form');
  const [newKeyName, setNewKeyName] = useState('');
  const [newSecretKey, setNewSecretKey] = useState('');

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  function handleOpenCreate() {
    setNewKeyName('');
    setCreateStep('form');
    setCreateOpen(true);
  }

  function handleCloseCreate() {
    setCreateOpen(false);
    setCreateStep('form');
  }

  function handleCreateKey() {
    const newKey: AccessKey = {
      id: String(Date.now()),
      name: newKeyName.trim(),
      accessKeyId: 'HKIA' + Math.random().toString(36).slice(2, 18).toUpperCase(),
      createdAt: new Date().toISOString(),
      lastUsedAt: undefined,
      status: 'active',
    };
    setKeys((prev) => [...prev, newKey]);
    setNewSecretKey('wJalrXUtnFEMI/' + Math.random().toString(36).slice(2, 30));
    setCreateStep('credentials');
  }

  function handleDoneCredentials() {
    setCreateOpen(false);
    setCreateStep('form');
    setNewKeyName('');
  }

  function handleToggle(id: string) {
    setKeys((prev) =>
      prev.map((k) =>
        k.id === id ? { ...k, status: k.status === 'active' ? 'inactive' : 'active' } : k,
      ),
    );
    toast.success('Access key updated');
  }

  function handleDelete(id: string) {
    setKeys((prev) => prev.filter((k) => k.id !== id));
    toast.success('Access key deleted');
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="p-8">
      <h1 className="mb-6 text-2xl font-semibold text-zinc-900">API &amp; Keys</h1>

      <Tabs>
        <TabList>
          <Tab>Access Keys</Tab>
          <Tab>Connection Details</Tab>
        </TabList>

        <TabPanels>
          <TabPanel>
            <AccessKeysTab
              keys={keys}
              onCreateOpen={handleOpenCreate}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          </TabPanel>

          <TabPanel>
            <ConnectionDetailsTab />
          </TabPanel>
        </TabPanels>
      </Tabs>

      <CreateKeyModal
        open={createOpen}
        onClose={handleCloseCreate}
        keys={keys}
        createStep={createStep}
        newKeyName={newKeyName}
        newSecretKey={newSecretKey}
        onNameChange={setNewKeyName}
        onCreateKey={handleCreateKey}
        onDone={handleDoneCredentials}
      />
    </div>
  );
}
