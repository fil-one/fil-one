import { z } from 'zod';

export interface PreferencesResponse {
  marketingEmailsOptedIn: boolean;
}

export const UpdatePreferencesSchema = z.object({
  marketingEmailsOptedIn: z.boolean(),
});

export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesSchema>;
