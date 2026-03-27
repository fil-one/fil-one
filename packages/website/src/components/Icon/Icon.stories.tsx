import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  CheckIcon,
  WarningIcon,
  DatabaseIcon,
  HardDriveIcon,
  CloudArrowUpIcon,
  KeyIcon,
  LockIcon,
  UserIcon,
  GearIcon,
  TrashIcon,
  PencilIcon,
  MagnifyingGlassIcon,
  BellIcon,
  CopyIcon,
  ArrowRightIcon,
  FolderIcon,
  FileIcon,
  LinkIcon,
  ShieldCheckIcon,
  InfoIcon,
} from '@phosphor-icons/react/dist/ssr';

import { Icon } from './Icon';

const meta: Meta<typeof Icon> = {
  title: 'Components/Icon',
  component: Icon,
};

export default meta;
type Story = StoryObj<typeof Icon>;

export const Default: Story = {
  args: {
    component: CheckIcon,
    size: 'lg',
  },
};

export const Small: Story = {
  args: {
    component: CheckIcon,
    size: 'sm',
  },
};

export const Medium: Story = {
  args: {
    component: CheckIcon,
    size: 'md',
  },
};

export const Success: Story = {
  args: {
    component: CheckIcon,
    size: 'lg',
    color: 'success',
  },
};

const ALL_ICONS = [
  { icon: CheckIcon, name: 'Check' },
  { icon: WarningIcon, name: 'Warning' },
  { icon: DatabaseIcon, name: 'Database' },
  { icon: HardDriveIcon, name: 'HardDrive' },
  { icon: CloudArrowUpIcon, name: 'CloudArrowUp' },
  { icon: KeyIcon, name: 'Key' },
  { icon: LockIcon, name: 'Lock' },
  { icon: UserIcon, name: 'User' },
  { icon: GearIcon, name: 'Gear' },
  { icon: TrashIcon, name: 'Trash' },
  { icon: PencilIcon, name: 'Pencil' },
  { icon: MagnifyingGlassIcon, name: 'MagnifyingGlass' },
  { icon: BellIcon, name: 'Bell' },
  { icon: CopyIcon, name: 'Copy' },
  { icon: ArrowRightIcon, name: 'ArrowRight' },
  { icon: FolderIcon, name: 'Folder' },
  { icon: FileIcon, name: 'File' },
  { icon: LinkIcon, name: 'Link' },
  { icon: ShieldCheckIcon, name: 'ShieldCheck' },
  { icon: InfoIcon, name: 'Info' },
];

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-8">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <div key={size}>
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">{size}</p>
          <div className="flex flex-wrap gap-4">
            {ALL_ICONS.map(({ icon, name }) => (
              <div key={name} className="flex flex-col items-center gap-1">
                <Icon component={icon} size={size} />
                <span className="text-[10px] text-zinc-400">{name}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Weights (lg)
        </p>
        <div className="flex flex-wrap gap-6">
          {(['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const).map((weight) => (
            <div key={weight} className="flex flex-col items-center gap-1">
              <Icon component={CheckIcon} size="lg" weight={weight} />
              <span className="text-[10px] text-zinc-400">{weight}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  ),
};
