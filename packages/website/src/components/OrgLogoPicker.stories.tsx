import type { Meta, StoryObj } from '@storybook/react-vite';

import { AvatarPicker, useOrgLogoUpload } from './OrgLogoPicker';

type Args = { name: string; logoUrl?: string; layout: 'dialog' | 'row'; disabled: boolean };

/** A thin host so the story can seed `useOrgLogoUpload`'s state via `initialLogoUrl`,
 * the same way `EditOrganizationDialog`'s Identity section would. */
function Host({ name, logoUrl, layout, disabled }: Args) {
  const logo = useOrgLogoUpload(logoUrl);
  return <AvatarPicker name={name} logo={logo} disabled={disabled} layout={layout} />;
}

const meta: Meta<Args> = {
  title: 'Components/OrgLogoPicker',
  render: (args) => <Host {...args} />,
  args: {
    name: 'Acme',
    layout: 'dialog',
    disabled: false,
  },
  argTypes: {
    layout: { control: 'radio', options: ['dialog', 'row'] },
  },
};

export default meta;
type Story = StoryObj<Args>;

/** The centered tile above the name field, for the create-organization dialog. */
export const Dialog: Story = {};

/** The left-aligned avatar-plus-caption row, for Edit organization's Identity section. */
export const Row: Story = {
  args: { layout: 'row' },
};

export const WithExistingLogo: Story = {
  args: {
    layout: 'row',
    logoUrl: 'https://avatars.githubusercontent.com/u/9919?s=64&v=4',
  },
};

export const Disabled: Story = {
  args: { layout: 'row', disabled: true },
};
