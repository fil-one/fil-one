import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellIcon } from '@phosphor-icons/react/dist/ssr';

import type { PreferencesResponse } from '@filone/shared';

import { SectionCard } from './SectionCard.js';
import { useToast } from './Toast/index.js';
import { getPreferences, updatePreferences } from '../lib/api.js';
import { queryKeys } from '../lib/query-client.js';
import { ToggleRow } from './ToggleRow';

export function NotificationSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: prefs, isPending } = useQuery({
    queryKey: queryKeys.preferences,
    queryFn: getPreferences,
  });

  const mutation = useMutation({
    mutationFn: updatePreferences,
    onSuccess: (result) => {
      queryClient.setQueryData<PreferencesResponse>(queryKeys.preferences, result);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update preferences');
    },
  });

  const marketingEnabled = prefs?.marketingEmailsOptedIn ?? false;

  return (
    <SectionCard
      icon={BellIcon}
      title="Notifications"
      description="Manage your notification preferences"
    >
      <div className="flex flex-col gap-3">
        <div className="opacity-50">
          <ToggleRow
            label="Email notifications"
            description="Get notified about your uploads and when approaching storage limits"
            enabled={false}
            disabled
          />
          <p className="text-xs text-zinc-400 italic">Coming soon</p>
        </div>
        <div className="h-px bg-[#e1e4ea]" />
        <ToggleRow
          label="Marketing emails"
          description="Receive updates about new features"
          enabled={marketingEnabled}
          disabled={isPending && !prefs}
          saving={mutation.isPending}
          onChange={() => mutation.mutate({ marketingEmailsOptedIn: !marketingEnabled })}
        />
      </div>
    </SectionCard>
  );
}
