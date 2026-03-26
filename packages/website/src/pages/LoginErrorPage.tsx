type LoginErrorPageProps = {
  error: string;
};

export function LoginErrorPage({ error }: LoginErrorPageProps) {
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
        <h1 className="text-2xl font-semibold text-zinc-950">Something went wrong</h1>
        <p className="text-sm text-zinc-500">{error}</p>
      </div>

      {/* Login button — uses <a> directly to trigger full navigation to the API endpoint */}
      <a href="/login" className="button button--filled w-full justify-center">
        Try signing in again
      </a>
    </div>
  );
}
