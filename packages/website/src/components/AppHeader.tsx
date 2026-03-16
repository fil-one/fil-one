import { QuestionIcon, BellIcon, SignOutIcon } from '@phosphor-icons/react/dist/ssr';
import { logout } from '../lib/api.js';

export function AppHeader() {
  return (
    <header className="flex h-14 flex-shrink-0 items-center border-b border-zinc-200 bg-white px-4 gap-4">
      {/* Spacer pushes right-side icons to the right */}
      <div className="flex-1" />

      {/* Right-side icon buttons */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Help"
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          <QuestionIcon size={18} />
        </button>

        <button
          type="button"
          aria-label="Notifications"
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          <BellIcon size={18} />
        </button>

        {/* User avatar — placeholder with initial "U" */}
        <div className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-medium text-white">
          U
        </div>

        <button
          type="button"
          aria-label="Sign out"
          onClick={logout}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
        >
          <SignOutIcon size={18} />
        </button>
      </div>
    </header>
  );
}
