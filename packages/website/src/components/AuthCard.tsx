import { clsx } from 'clsx';

import { Card } from './Card';

type AuthCardProps = {
  children: React.ReactNode;
  /** Optional secondary line rendered below the card, e.g. a sign-out escape hatch. */
  footer?: React.ReactNode;
  className?: string;
};

/**
 * The standalone card shell shared by the pre/around-auth pages (verify email,
 * login error, route recovery). Mirrors the Auth0 Universal Login card so these
 * app-owned screens read as one surface with Auth0's hosted ones: a flat zinc-50
 * ground with no brand wash, a single white card carrying the Fil One lockup, and
 * the same soft layered shadow as docs/auth0/universal-login-template.liquid.
 * Extra bottom padding lifts the card off true centre, which optically reads as
 * centred.
 */
export function AuthCard({ children, footer, className }: AuthCardProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-zinc-50 px-5 pt-12 pb-24">
      <Card
        padding="none"
        shadow={false}
        className={clsx(
          'w-full max-w-[380px] p-8 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)]',
          className,
        )}
      >
        <img src="/fil-one-logo.svg" alt="Fil One" className="mb-8 h-5 w-auto" />
        {children}
      </Card>
      {footer}
    </div>
  );
}
