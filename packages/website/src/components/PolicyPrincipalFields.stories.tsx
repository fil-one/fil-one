import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { PolicyStatement } from '@filone/shared';

import {
  ADA_ID,
  REMOVED_MEMBER_ID,
  answersUnavailable,
  buildLongRoster,
  neverAnswers,
  storyRoster,
  withMembers,
  withRequestsAnswered,
} from '../lib/story-members';
import { PolicyPrincipalFields } from './PolicyPrincipalFields';

function Controlled({ initial }: { initial: PolicyStatement['Principal'] }) {
  const [value, setValue] = useState(initial);
  return <PolicyPrincipalFields value={value} onChange={setValue} />;
}

const meta: Meta<typeof Controlled> = {
  title: 'Components/PolicyPrincipalFields',
  component: Controlled,
};

export default meta;
type Story = StoryObj<typeof Controlled>;

export const Everyone: Story = { args: { initial: '*' } };

export const SpecificMembers: Story = {
  args: { initial: [ADA_ID] },
  decorators: [withMembers(storyRoster)],
};

/** A member the roster no longer lists stays selected, named as unknown. */
export const UnknownMember: Story = {
  args: { initial: [ADA_ID, REMOVED_MEMBER_ID] },
  decorators: [withMembers(storyRoster)],
};

export const LongRoster: Story = {
  args: { initial: [] },
  decorators: [withMembers(buildLongRoster(60))],
};

export const Empty: Story = {
  args: { initial: [] },
  decorators: [withMembers([])],
};

export const Loading: Story = {
  args: { initial: [] },
  decorators: [withRequestsAnswered(neverAnswers)],
};

export const Error: Story = {
  args: { initial: [ADA_ID] },
  decorators: [withRequestsAnswered(answersUnavailable)],
};
