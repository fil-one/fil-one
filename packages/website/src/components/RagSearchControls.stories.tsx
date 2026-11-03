import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';

import type { RagSearchMode } from '@filone/shared';

import { engineVersions } from '../lib/rag-engine-fixtures.js';
import { RagSearchControls } from './RagSearchControls';

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
