import { useState } from 'react';

import { clsx } from 'clsx';

import { RAG_SEARCH_MODES, type RagEngineVersion, type RagSearchMode } from '@filone/shared';

import { SEARCH_MODE_HINTS, SEARCH_MODE_LABELS, formatVersionTime } from '../lib/rag-engine.js';
import { Select } from './Select.js';

export type RagSearchControlsProps = {
  mode: RagSearchMode;
  onModeChange: (mode: RagSearchMode) => void;
  /** Selected dataset version, or undefined for the latest. */
  version: number | undefined;
  onVersionChange: (version: number | undefined) => void;
  /** Dataset versions, newest first. */
  versions: RagEngineVersion[];
  disabled?: boolean;
};

/**
 * The selected dataset version, or undefined for the latest. A selection that
 * drops out of the version list (a failed history read, or cleanup removing old
 * versions) resets to Latest, so the picker and the version a question is
 * asked of always agree.
 */
export function useDatasetVersion(versions: RagEngineVersion[]) {
  const [version, setVersion] = useState<number | undefined>(undefined);
  const missing = version !== undefined && !versions.some((v) => v.version === version);
  if (missing) setVersion(undefined);
  return [missing ? undefined : version, setVersion] as const;
}

/**
 * Search mode and dataset version for an engine-backed (Forge) bucket's query.
 * The segmented control follows the usage chart's period picker; the version
 * picker lists the Lance dataset's history so a question can be asked of the
 * bucket as it was at any earlier sync.
 */
export function RagSearchControls({
  mode,
  onModeChange,
  version,
  onVersionChange,
  versions,
  disabled,
}: RagSearchControlsProps) {
  const latest = versions[0];
  const historical = version !== undefined && version !== latest?.version;
  const selectedVersion = versions.find((v) => v.version === version);

  return (
    <div data-testid="rag-search-controls" className="mb-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Search mode"
          className="inline-flex rounded-lg bg-zinc-100 p-0.5"
        >
          {RAG_SEARCH_MODES.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`search-mode-${value}`}
              disabled={disabled}
              title={SEARCH_MODE_HINTS[value]}
              onClick={() => onModeChange(value)}
              aria-pressed={mode === value}
              className={clsx(
                'rounded-md px-2.5 py-1 text-meta font-medium transition-colors duration-150 focus-visible:brand-outline disabled:cursor-not-allowed disabled:opacity-50',
                mode === value
                  ? 'bg-white text-zinc-900 shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-900',
              )}
            >
              {SEARCH_MODE_LABELS[value]}
            </button>
          ))}
        </div>
        <div className="ml-auto w-56">
          <Select
            aria-label="Dataset version"
            data-testid="version-select"
            selectSize="sm"
            disabled={disabled || versions.length === 0}
            value={version === undefined ? '' : String(version)}
            onChange={(value) => onVersionChange(value === '' ? undefined : Number(value))}
          >
            <option value="">{latest ? `Latest (v${latest.version})` : 'Latest'}</option>
            {versions.slice(latest ? 1 : 0).map((v) => (
              <option key={v.version} value={String(v.version)}>
                {`v${v.version} · ${formatVersionTime(v.timestamp)}`}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p data-testid="search-mode-hint" className="text-meta text-zinc-500">
        {SEARCH_MODE_HINTS[mode]}.
        {historical && selectedVersion && (
          <span data-testid="version-hint" className="text-amber-700">
            {' '}
            Searching version {selectedVersion.version}
            {selectedVersion.tags?.length ? ` (${selectedVersion.tags.join(', ')})` : ''}, committed{' '}
            {formatVersionTime(selectedVersion.timestamp)}.
          </span>
        )}
      </p>
    </div>
  );
}
