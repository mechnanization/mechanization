import Link from 'next/link';
import { FileQuestion } from 'lucide-react';

/**
 * The portal's 404.
 *
 * There was none, so an unknown URL fell through to Next's built-in page —
 * unstyled, left-to-right, and in English, which for an Arabic municipal portal
 * reads as a broken deployment rather than a mistyped address. The middleware
 * also rewrites a bare `/` here, and that rewrite pointed at a route that did
 * not exist.
 *
 * Deliberately offers no link "home": there is no home without a municipality
 * in the URL, and inventing one would send a visitor to a slug they may have no
 * business at. What it does instead is name the two things that are actually
 * wrong most often — a mistyped address, or a link that has moved.
 *
 * `dir="rtl"` locally rather than inheriting: this file sits above
 * `[tenant]/[locale]/layout.tsx`, so nothing has set a direction by the time it
 * renders.
 */
export default function NotFound() {
  return (
    <html lang="ar" dir="rtl">
      <body className="min-h-screen bg-background font-sans antialiased">
        <div
          dir="rtl"
          lang="ar"
          className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center"
        >
          <span
            aria-hidden
            className="flex size-16 items-center justify-center rounded-xl bg-muted text-muted-foreground"
          >
            <FileQuestion className="size-8" />
          </span>

          <div className="space-y-2">
            <p className="font-mono text-sm tracking-[0.2em] text-muted-foreground">404</p>
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
              الصفحة غير موجودة
            </h1>
            <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
              تعذّر العثور على هذه الصفحة. تأكّد من العنوان، أو ارجع إلى الصفحة السابقة —
              قد يكون الرابط قديماً.
            </p>
          </div>

          <Link
            href="/"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            الصفحة الرئيسية
          </Link>
        </div>
      </body>
    </html>
  );
}
