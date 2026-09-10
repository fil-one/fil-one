import { AuthCard } from '../components/AuthCard';
import { Button } from '../components/Button';
import { Heading } from '../components/Heading/Heading';
import { logout } from '../lib/api.js';

/**
 * Text buttons carry no chrome, so they need their own keyboard-only ring.
 * Kept identical to the one on the verify and create-organization pages: all
 * three gates sit in the same flow, and a differently styled escape hatch on
 * each would read as two different products.
 */
const textButton =
  'rounded-xs font-medium text-brand-600 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600';

type LeftLastOrgPageProps = {
  /** The signed-in address, so the footer can name the account this is about. */
  email?: string;
};

/**
 * Reached when leaving an organization - by choice, by an admin's removal, or
 * because the organization itself was deleted - drops the caller to zero
 * memberships. There is no account without an org to be in, so this is the
 * fork before one gets created for them: start a new organization of their
 * own, or leave Fil One altogether instead.
 *
 * Deleting the account isn't self-serve yet (FIL-1135 covers what that flow
 * needs to account for across a caller's other memberships - moot here,
 * since by definition there are none left), so it points at support the same
 * way every other danger-zone surface does today, rather than a button in
 * front of a flow that doesn't exist.
 */
export function LeftLastOrgPage({ email }: LeftLastOrgPageProps) {
  return (
    <AuthCard
      footer={
        // Which account this is about, and the way out - same shape as
        // WelcomePage's own footer, since the two gates sit in the same flow.
        email ? (
          <div className="text-center">
            <p className="text-xs text-(--color-paragraph-text)">Signed in as {email}</p>
            <p className="mt-1 text-xs text-(--color-paragraph-text-subtle)">
              Not your account?{' '}
              <button type="button" onClick={logout} className={textButton}>
                Sign out
              </button>
            </p>
          </div>
        ) : undefined
      }
    >
      <Heading tag="h1" size="lg" balance className="font-normal tracking-tight">
        You&rsquo;ve left your last organization
      </Heading>
      <p className="mt-2 text-sm text-(--color-paragraph-text)">
        Create a new organization to keep storing and sharing data on Fil One.
      </p>

      <Button
        href="/create-organization"
        variant="primary"
        className="mt-6 w-full justify-center py-3.5"
      >
        Create an organization
      </Button>

      <p className="mt-3 text-center text-xs text-(--color-paragraph-text-subtle)">
        Don&rsquo;t want to keep using Fil One? Email{' '}
        <a href="mailto:support@fil.one" className={textButton}>
          support@fil.one
        </a>{' '}
        to delete your account instead.
      </p>
    </AuthCard>
  );
}
