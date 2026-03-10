import {
  DatabaseIcon,
  GlobeIcon,
  HardDriveIcon,
  LightningIcon,
} from '@phosphor-icons/react/dist/ssr';

type AuthLayoutProps = {
  children: React.ReactNode;
};

type FeatureItem = {
  icon: React.ElementType;
  text: string;
};

const features: FeatureItem[] = [
  {
    icon: DatabaseIcon,
    text: 'Content-addressable storage with unique CIDs',
  },
  {
    icon: GlobeIcon,
    text: 'S3-compatible API — use existing workflows',
  },
  {
    icon: HardDriveIcon,
    text: 'Built for large files up to petabytes',
  },
  {
    icon: LightningIcon,
    text: 'Pay only for what you use',
  },
];

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen">
      {/* Left panel — form area */}
      <div className="flex w-full max-w-[480px] flex-col items-center justify-center bg-white px-8 py-12">
        {children}
      </div>

      {/* Right panel — marketing area */}
      <div className="hidden flex-1 flex-col items-center justify-center bg-zinc-50 px-12 py-16 lg:flex">
        {/* Badge */}
        <div className="mb-8 rounded-full bg-zinc-100 px-4 py-1.5 text-sm text-zinc-700">
          🚀 1 TiB free for 14 days — no credit card required
        </div>

        {/* Heading */}
        <h1 className="mb-4 max-w-sm text-center text-3xl font-semibold text-zinc-950">
          S3-compatible storage on Filecoin
        </h1>

        {/* Subtext */}
        <p className="mb-10 max-w-sm text-center text-base text-zinc-600">
          Store objects with verifiable content addressing. Use your existing S3 tools.
        </p>

        {/* Feature list */}
        <ul className="mb-12 flex w-full max-w-sm flex-col gap-4">
          {features.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                <Icon size={18} />
              </span>
              <span className="text-sm text-zinc-700">{text}</span>
            </li>
          ))}
        </ul>

        {/* Footer */}
        <p className="text-sm text-zinc-400">
          Trusted by teams storing critical data on the decentralized web
        </p>
      </div>
    </div>
  );
}
