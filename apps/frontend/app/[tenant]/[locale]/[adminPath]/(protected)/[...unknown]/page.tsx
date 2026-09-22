'use client';

import { use } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * An unknown URL *inside* the admin area.
 *
 * A catch-all rather than relying on the root `not-found.tsx`, because the two
 * are different situations. The root 404 is for someone who mistyped a
 * municipality; this is for a signed-in clerk who followed a stale link, and
 * they should land somewhere that still has the sidebar, still knows which
 * municipality they are in, and offers one click back to work.
 *
 * Next matches specific segments before a catch-all, so `/dashboard`,
 * `/citizens` and every other real route are unaffected — this only sees what
 * nothing else claimed.
 */
export default function AdminNotFound({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const pathname = usePathname();

  return (
    <div className="relative flex min-h-[65dvh] flex-col items-center justify-center gap-7 overflow-hidden px-6 text-center">
      {/* Same soft primary glow the sign-in screen uses — a plain grey icon on
          an otherwise blank page reads as broken; this reads as designed. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center"
      >
        <div className="size-[26rem] rounded-full bg-primary/10 blur-3xl" />
      </div>

      <span
        aria-hidden
        className="flex size-16 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15"
      >
        <Compass className="size-8" />
      </span>

      <div className="space-y-2">
        <p className="font-mono text-sm tracking-[0.2em] text-muted-foreground">404</p>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {locale === 'en' ? 'Page Not Found' : 'الصفحة غير موجودة'}
        </h1>
        <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
          {locale === 'en'
            ? 'This link does not match any page in the admin portal. It may be outdated or mistyped.'
            : 'هذا الرابط لا يقابل أي صفحة في لوحة الإدارة. قد يكون قديماً أو مكتوباً بشكل خاطئ.'}
        </p>
        {/* The path itself, so a stale bookmark or a fat-fingered edit is
            visible rather than guessed at. */}
        {pathname ? (
          <p
            dir="ltr"
            className="mx-auto mt-2 max-w-sm truncate rounded-md border border-border/60 bg-muted/60 px-3 py-1.5 font-mono text-xs text-muted-foreground"
          >
            {pathname}
          </p>
        ) : null}
      </div>

      <Button asChild className="shadow-sm">
        <Link href={base}>
          {locale === 'en' ? 'Return to Admin Portal' : 'العودة إلى لوحة الإدارة'}
        </Link>
      </Button>
    </div>
  );
}
