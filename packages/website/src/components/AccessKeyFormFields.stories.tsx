import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';

import type { ListBucketsResponse } from '@filone/shared';
import { OrgRole, S3_REGION, S3Region } from '@filone/shared';

import { queryKeys } from '../lib/query-client';
import { useAccessKeyForm } from '../lib/use-access-key-form';
import { AccessKeyFormFields } from './AccessKeyFormFields';

const mockBuckets: ListBucketsResponse = {
  buckets: [
    {
      bucketName: 'my-bucket',
      region: 'us-east-1',
      createdAt: '2026-01-15T00:00:00Z',
      isPublic: false,
    },
    {
      bucketName: 'backups',
      region: 'us-east-1',
      createdAt: '2026-02-20T00:00:00Z',
      isPublic: false,
    },
    { bucketName: 'media', region: 'eu-west-1', createdAt: '2026-03-01T00:00:00Z', isPublic: true },
  ],
};

const meta: Meta<typeof AccessKeyFormFields> = {
  title: 'Components/AccessKeyFormFields',
  component: AccessKeyFormFields,
};

export default meta;
type Story = StoryObj<typeof AccessKeyFormFields>;

type StoryContentProps = {
  pinnedBucket?: string;
  showRegionSelector?: boolean;
  initialRegion?: S3Region;
};

function AccessKeyFormFieldsStoryContent({
  pinnedBucket,
  showRegionSelector = true,
  initialRegion = S3_REGION,
}: StoryContentProps) {
  const [region, setRegion] = useState<S3Region>(initialRegion);
  const form = useAccessKeyForm({
    defaultBucket: pinnedBucket,
    region,
    onSuccess: () => {},
  });

  return (
    <AccessKeyFormFields
      form={form}
      pinnedBucket={pinnedBucket}
      region={region}
      onRegionChange={showRegionSelector ? setRegion : undefined}
    />
  );
}

// The buckets go into the preview's client, which already holds the story's
// role; a client of its own would lose it. Seeded before the first render and
// never stale, since no server answers a refetch.
function AccessKeyFormFieldsWrapper(props: StoryContentProps) {
  const queryClient = useQueryClient();
  useState(() => {
    queryClient.setQueryDefaults(queryKeys.buckets, { staleTime: Infinity });
    queryClient.setQueryData(queryKeys.buckets, mockBuckets);
  });

  return <AccessKeyFormFieldsStoryContent {...props} />;
}

export const Default: Story = {
  render: () => <AccessKeyFormFieldsWrapper />,
};

export const WithPinnedBucket: Story = {
  render: () => <AccessKeyFormFieldsWrapper pinnedBucket="my-bucket" />,
};

export const WithoutRegionSelector: Story = {
  render: () => <AccessKeyFormFieldsWrapper showRegionSelector={false} />,
};

export const PersonalKeyOnIamRegion: Story = {
  render: () => <AccessKeyFormFieldsWrapper initialRegion={S3Region.UsEast9} />,
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('What kind of key?')).toBeVisible();
  },
};

export const ServiceKeyOnIamRegion: Story = {
  render: () => <AccessKeyFormFieldsWrapper initialRegion={S3Region.UsEast9} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText(/Service key/));
    await expect(await canvas.findByTestId('permission-read')).toBeVisible();
  },
};

export const MemberOnIamRegion: Story = {
  parameters: { role: OrgRole.Member },
  render: () => <AccessKeyFormFieldsWrapper initialRegion={S3Region.UsEast9} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Key name');
    await expect(canvas.queryByText('What kind of key?')).toBeNull();
  },
};
