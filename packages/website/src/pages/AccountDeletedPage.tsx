import { CheckCircleIcon } from '@phosphor-icons/react/dist/ssr';
import { Card } from '../components/Card';
import { Heading } from '../components/Heading/Heading';
import { IconBox } from '../components/IconBox';
import { Link } from '../components/Link';

/**
 * Unauthenticated by design: the browser can land here with session cookies
 * already cleared or still live, so this must render without fetching `/me` or
 * any app chrome.
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
            Your subscription is being cancelled, your access keys are revoked, and your buckets,
            objects and account data are being removed. This can take a few minutes to finish.
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
