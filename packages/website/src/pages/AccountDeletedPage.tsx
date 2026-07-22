import { CheckCircleIcon } from '@phosphor-icons/react/dist/ssr';
import { Card } from '../components/Card';
import { Heading } from '../components/Heading/Heading';
import { IconBox } from '../components/IconBox';
import { Link } from '../components/Link';

/**
 * Static post-deletion confirmation (FIL-112). Unauthenticated by design:
 * the session cookies were cleared by the delete response, so this page
 * must not fetch /me or render any app chrome.
 */
export function AccountDeletedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <Card className="max-w-md">
        <div className="flex flex-col items-center gap-3 p-4 text-center">
          <IconBox icon={CheckCircleIcon} color="blue" size="lg" />
          <Heading tag="h1" size="sm">
            Your account has been deleted
          </Heading>
          <p className="text-sm text-zinc-500">
            Your subscription has been canceled, your access keys are revoked, and your profile and
            account data are being removed. Object data held by our storage provider is locked and
            inaccessible, and is scheduled for later destruction.
          </p>
          <p className="text-sm text-zinc-500">
            Thanks for trying Fil One. You can close this page, or head back to{' '}
            <Link href="https://fil.one" variant="accent">
              fil.one
            </Link>
            .
          </p>
        </div>
      </Card>
    </div>
  );
}
