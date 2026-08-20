import { Heading } from '../components/Heading/Heading';
import { AuthCard } from '../components/AuthCard';

type LoginErrorPageProps = {
  error: string;
};

/**
 * The callback handler (packages/backend/src/handlers/auth-callback.ts) redirects
 * here with a raw developer reason in `?error=` — "Invalid state", "Token exchange
 * failed", "Authentication failed", or whatever Auth0 returns in error_description.
 * None of those mean anything to a user, so map the ones we emit to human copy and
 * fall back to a generic retry message for everything else (e.g. Auth0's codes).
 */
const reasonCopy: Record<string, string> = {
  'Invalid state': 'Your sign-in link expired or was already used. Please try signing in again.',
  'Token exchange failed': "We couldn't finish signing you in. Please try again.",
  'Authentication failed': "We couldn't finish signing you in. Please try again.",
};

function describeError(error: string): string {
  return reasonCopy[error] ?? 'Something interrupted sign-in. Please try again.';
}

export function LoginErrorPage({ error }: LoginErrorPageProps) {
  return (
    <AuthCard>
      <Heading
        id="login-error-heading"
        tag="h1"
        size="lg"
        balance
        className="font-normal tracking-tight"
      >
        We couldn't sign you in
      </Heading>
      <p className="mt-2 text-sm text-(--color-paragraph-text)">{describeError(error)}</p>

      {/* Plain <a>, not the Button component: retry must trigger a full document
          navigation to the server login endpoint, not a client route change. */}
      <a
        id="login-error-retry-button"
        href="/login"
        className="button button--primary button--lg mt-6 w-full justify-center py-3.5"
      >
        Try signing in again
      </a>
    </AuthCard>
  );
}
