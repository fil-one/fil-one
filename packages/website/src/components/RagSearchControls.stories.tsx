import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import type { RagSearchMode } from '@filone/shared';

import { engineVersions } from '../lib/rag-engine-fixtures.js';
import { RagSearchControls, useDatasetVersion } from './RagSearchControls';

const meta: Meta<typeof RagSearchControls> = {
  title: 'Components/RagSearchControls',
  component: RagSearchControls,
  decorators: [
    (Story) => (
      <div className="w-[520px] max-w-full">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof RagSearchControls>;

function Interactive({
  initialMode = 'hybrid',
  initialVersion,
  disabled,
  empty,
}: {
  initialMode?: RagSearchMode;
  initialVersion?: number;
  disabled?: boolean;
  empty?: boolean;
}) {
  const [mode, setMode] = useState<RagSearchMode>(initialMode);
  const [version, setVersion] = useState<number | undefined>(initialVersion);
  return (
    <RagSearchControls
      mode={mode}
      onModeChange={setMode}
      version={version}
      onVersionChange={setVersion}
      versions={empty ? [] : engineVersions}
      disabled={disabled}
    />
  );
}

/** Hybrid search on the latest version. */
export const Default: Story = { render: () => <Interactive /> };

/** Full-text search. */
export const FullText: Story = { render: () => <Interactive initialMode="fulltext" /> };

/** Searching an earlier version: the hint says which. */
export const EarlierVersion: Story = {
  render: () => <Interactive initialMode="vector" initialVersion={11} />,
};

/** Not indexed yet: nothing to search. */
export const Disabled: Story = { render: () => <Interactive disabled empty /> };

/** The version history the presenter picked from goes away (a failed read, or cleanup). */
function VersionsDropOut() {
  const [mode, setMode] = useState<RagSearchMode>('hybrid');
  const [versions, setVersions] = useState(engineVersions);
  const [version, setVersion] = useDatasetVersion(versions);
  return (
    <div>
      <RagSearchControls
        mode={mode}
        onModeChange={setMode}
        version={version}
        onVersionChange={setVersion}
        versions={versions}
      />
      <button type="button" className="text-meta text-zinc-500" onClick={() => setVersions([])}>
        Drop version history
      </button>
    </div>
  );
}

/** A selected version that leaves the list resets the picker to Latest. */
export const SelectedVersionRemoved: Story = {
  render: () => <VersionsDropOut />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = canvas.getByLabelText('Dataset version');
    await userEvent.selectOptions(select, '11');
    await expect(canvas.getByTestId('version-hint')).toHaveTextContent('Searching version 11');
    await userEvent.click(canvas.getByRole('button', { name: 'Drop version history' }));
    await expect(select).toHaveValue('');
    await expect(canvas.queryByTestId('version-hint')).not.toBeInTheDocument();
  },
};
