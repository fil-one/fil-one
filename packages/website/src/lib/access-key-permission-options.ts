import type { ObjectPermission } from '@filone/shared';

export type PermissionOption = {
  value: ObjectPermission;
  label: string;
  description: string;
};

/** The four object permissions, in the order every permission UI shows them. */
export const PERMISSION_OPTIONS: PermissionOption[] = [
  { value: 'read', label: 'Read', description: 'Download and retrieve objects' },
  { value: 'write', label: 'Write', description: 'Upload and overwrite objects' },
  { value: 'list', label: 'List', description: 'Browse and list objects' },
  { value: 'delete', label: 'Delete', description: 'Permanently remove objects' },
];
