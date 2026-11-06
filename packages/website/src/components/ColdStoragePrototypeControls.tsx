import { useState } from 'react';
import { FlaskIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from './Button';
import { Switch } from './Switch';
import {
  resetPrototype,
  updatePrototypeSettings,
  usePrototypeSettings,
  type PrototypeSettings,
} from '../lib/cold-storage-prototype.js';

const SETTINGS: { key: keyof PrototypeSettings; label: string }[] = [
  { key: 'demoBucket', label: 'Add a demo bucket (raw-footage-2021)' },
  { key: 'shortWaits', label: 'Short waits (a day lasts 10 seconds, a restore takes 10)' },
  { key: 'trialAccount', label: 'Trial account' },
  { key: 'memberRole', label: 'Member role' },
];

/**
 * Switches for walking every branch of the flow in a demo: real runs are
 * daily, real restores take an hour, and the eligibility checks depend on the
 * account. Collapsed to one button by default so it covers nothing at 375px.
 */
export function ColdStoragePrototypeControls() {
  const settings = usePrototypeSettings();
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed bottom-4 left-4 z-40 flex flex-col items-start gap-2">
      {open && (
        <div
          className="flex w-72 flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-md"
          data-testid="cold-storage-prototype-controls"
        >
          <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
            Prototype controls
          </p>
          {SETTINGS.map(({ key, label }) => (
            <label
              key={key}
              className="flex items-center justify-between gap-3 text-ui text-zinc-700"
            >
              {label}
              <Switch
                aria-label={label}
                checked={settings[key]}
                onChange={(checked) => updatePrototypeSettings({ [key]: checked })}
              />
            </label>
          ))}
          {settings.shortWaits && (
            <p className="text-xs text-zinc-500">
              Daily runs happen every 10 seconds, a 2-week restore lasts 140 seconds and a 90-day
              term 15 minutes.
            </p>
          )}
          <Button
            id="cold-storage-prototype-reset"
            variant="ghost"
            size="sm"
            onClick={resetPrototype}
          >
            Clear every freeze and restore, and show the announcement again
          </Button>
        </div>
      )}
      <Button
        id="cold-storage-prototype-toggle"
        variant="ghost"
        size="sm"
        icon={FlaskIcon}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="bg-white shadow-md"
      >
        Prototype
      </Button>
    </div>
  );
}
