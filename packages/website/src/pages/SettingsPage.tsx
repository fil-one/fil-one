import { useState } from 'react';

import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/Modal';
import { useToast } from '../components/Toast';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_USER = { name: 'Joe Muoio', email: 'joe@example.com' };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SettingsPage() {
  const { toast } = useToast();

  // Profile state
  const [name, setName] = useState(MOCK_USER.name);
  const [email] = useState(MOCK_USER.email);

  // Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Delete account modal state
  const [deleteOpen, setDeleteOpen] = useState(false);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  function handleSaveProfile() {
    // UNKNOWN: Real profile update API call not implemented — UI-only.
    toast.success('Profile updated');
  }

  function handleUpdatePassword() {
    // UNKNOWN: Real password change API call not implemented — UI-only.
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    toast.success('Password updated');
  }

  function handleDeleteAccount() {
    // UNKNOWN: Account deletion would need real auth + API. This is UI-only.
    setDeleteOpen(false);
    toast.info('Account deletion requested');
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-zinc-900 mb-6">Settings</h1>

      {/* ------------------------------------------------------------------ */}
      {/* Profile */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-zinc-200 bg-white p-6 mb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-4">
          Profile
        </h2>

        <div className="flex flex-col gap-4 max-w-md">
          {/* Full name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700">Full name</label>
            <Input value={name} onChange={setName} placeholder="Your full name" />
          </div>

          {/* Email — read-only */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700">Email</label>
            <Input
              value={email}
              onChange={() => {
                /* read-only */
              }}
              disabled
              placeholder="you@example.com"
            />
            <p className="text-xs text-zinc-400 mt-1">Email cannot be changed here.</p>
          </div>

          <div>
            <Button variant="filled" onClick={handleSaveProfile}>
              Save changes
            </Button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Password */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-zinc-200 bg-white p-6 mb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-4">
          Password
        </h2>

        <div className="flex flex-col gap-4 max-w-md">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700">Current password</label>
            <Input
              type="password"
              value={currentPassword}
              onChange={setCurrentPassword}
              placeholder="Current password"
              autoComplete="current-password"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700">New password</label>
            <Input
              type="password"
              value={newPassword}
              onChange={setNewPassword}
              placeholder="New password"
              autoComplete="new-password"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-700">Confirm password</label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder="Confirm new password"
              autoComplete="new-password"
            />
          </div>

          <div>
            <Button variant="filled" onClick={handleUpdatePassword}>
              Update password
            </Button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Danger Zone */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-lg border border-red-200 bg-white p-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-red-600 mb-4">
          Danger Zone
        </h2>

        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-zinc-900">Delete account</span>
            <span className="text-sm text-zinc-500">
              This will permanently delete your account and all data.
            </span>
          </div>
          <div className="shrink-0">
            <Button
              variant="ghost"
              onClick={() => setDeleteOpen(true)}
              className="border-red-300 text-red-600 hover:bg-red-50"
            >
              Delete account
            </Button>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Delete Account Confirm Modal */}
      {/* ------------------------------------------------------------------ */}
      {/* UNKNOWN: Account deletion would need real auth + API. This is UI-only. */}
      <Modal open={deleteOpen} onClose={() => setDeleteOpen(false)} size="sm">
        <ModalHeader onClose={() => setDeleteOpen(false)}>Delete account</ModalHeader>
        <ModalBody>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-zinc-700">
              Are you sure you want to delete your account? This action is{' '}
              <strong>permanent</strong> and cannot be undone.
            </p>
            <p className="text-sm text-zinc-500">
              All your buckets, objects, and access keys will be permanently removed.
            </p>
          </div>
        </ModalBody>
        <ModalFooter>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="ghost"
              onClick={handleDeleteAccount}
              className="border-red-300 text-red-600 hover:bg-red-50"
            >
              Delete account
            </Button>
          </div>
        </ModalFooter>
      </Modal>
    </div>
  );
}
