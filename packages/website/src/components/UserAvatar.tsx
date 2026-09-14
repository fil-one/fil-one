import { useEffect, useState } from 'react';
import { cn } from '../lib/utils.js';

type UserAvatarProps = {
  /** Profile picture URL, e.g. the `picture` claim from a GitHub or Google sign-in. */
  src?: string;
  /** One- or two-letter fallback shown when there is no picture or it fails to load. */
  initial: string;
  className?: string;
};

/**
 * Circular profile picture with an initial fallback. The initial sits underneath
 * the image so a slow, blocked, or broken picture degrades to the initial rather
 * than an empty circle. Decorative by design — the surrounding control carries
 * the accessible name, so the avatar is hidden from assistive technology.
 */
export function UserAvatar({ src, initial, className }: UserAvatarProps) {
  const [status, setStatus] = useState<'pending' | 'loaded' | 'failed'>('pending');

  // A new picture URL deserves a fresh attempt after a previous one failed.
  useEffect(() => setStatus('pending'), [src]);

  const showImage = !!src && status !== 'failed';

  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-600 text-xs font-semibold text-white',
        className,
      )}
    >
      {/* Hidden once the picture is up, so a transparent avatar does not show it through. */}
      {status !== 'loaded' && initial}
      {showImage && (
        <img
          src={src}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('failed')}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}
