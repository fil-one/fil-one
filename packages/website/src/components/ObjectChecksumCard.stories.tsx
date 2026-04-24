import type { Meta, StoryObj } from '@storybook/react-vite';

import { ObjectChecksumCard } from './ObjectChecksumCard';

const meta: Meta<typeof ObjectChecksumCard> = {
  title: 'Components/ObjectChecksumCard',
  component: ObjectChecksumCard,
};

export default meta;
type Story = StoryObj<typeof ObjectChecksumCard>;

export const Sha256: Story = {
  args: {
    checksums: {
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  },
};

export const Crc32: Story = {
  args: {
    checksums: {
      crc32: 'AAAAAA==',
    },
  },
};

export const UnknownAlgorithm: Story = {
  args: {
    checksums: {
      blake3: '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213',
    },
  },
};

export const NoChecksum: Story = {
  args: {
    checksums: undefined,
  },
};

export const EmptyChecksums: Story = {
  args: {
    checksums: {},
  },
};
