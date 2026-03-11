import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Input } from '@hyperspace/ui/Input';
import { Button } from '@hyperspace/ui/Button';
import { DividerWithLabel } from '@hyperspace/ui/DividerWithLabel';
import { redirectToLogin } from '../../lib/api.js';

export function SignUpPage() {
  const [email, setEmail] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    redirectToLogin({ loginHint: email, screenHint: 'signup' });
  }

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">
          F
        </span>
        <span className="text-sm font-semibold text-zinc-900">Fil.one</span>
      </div>

      {/* Heading */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-zinc-950">Create your account</h1>
        <p className="text-sm text-zinc-500">Start storing objects on Filecoin</p>
      </div>

      {/* Social buttons — redirect to Auth0 Universal Login with connection hint */}
      {/* TODO [Option D]: Social connections configured in Auth0 dashboard. When on a
         custom domain these will use first-party cookies automatically. */}
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => redirectToLogin({ screenHint: 'signup', connection: 'google-oauth2' })}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <span className="font-bold text-[#4285F4]">G</span>
          Continue with Google
        </button>
        <button
          type="button"
          onClick={() => redirectToLogin({ screenHint: 'signup', connection: 'github' })}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
        >
          <GitHubIcon />
          Continue with GitHub
        </button>
      </div>

      <DividerWithLabel label="or continue with email" />

      {/* Form — collects email only; Auth0 Universal Login handles credentials */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="sign-up-email" className="text-sm font-medium text-zinc-700">
            Email
          </label>
          <Input
            id="sign-up-email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={setEmail}
            required
            autoComplete="email"
          />
        </div>

        <Button variant="filled" type="submit" className="w-full justify-center">
          Continue
        </Button>
      </form>

      {/* Footer links */}
      <p className="text-center text-sm text-zinc-500">
        Already have an account?{' '}
        <Link to="/sign-in" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>

      <p className="text-center text-xs text-zinc-400">
        By continuing, you agree to our{' '}
        <a href="#" className="underline hover:text-zinc-600">
          Terms
        </a>{' '}
        and{' '}
        <a href="#" className="underline hover:text-zinc-600">
          Privacy Policy
        </a>
        .
      </p>
    </div>
  );
}

// Minimal GitHub mark SVG — keeps the bundle lean.
function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="text-zinc-800"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.22.83 1.22.83.72 1.23 1.87.87 2.33.67.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.96 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.66 7.66 0 018 3.8c.68 0 1.36.09 2 .27 1.52-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.08-1.87 3.75-3.65 3.96.29.25.54.73.54 1.48v2.19c0 .21.15.46.55.38A8 8 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
