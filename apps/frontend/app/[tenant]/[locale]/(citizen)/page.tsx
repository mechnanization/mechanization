'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileSearch, Loader2 } from 'lucide-react';
import { ApiRequestError, logApiError, openByReference } from '@/lib/api-client';
import { loadSession, saveSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useTranslations } from 'next-intl';

import {
  formatReference,
  isCompleteReference,
  nextReferenceValue,
  REFERENCE_RAW_LENGTH,
  toRawReference,
} from '@/lib/reference';

/**
 * The municipality's front door: one field, the citizen's رقم مرجعي.
 *
 * Everything else that used to sit here — the sign-in card, the "what to bring
 * to the counter" checklist — is gone on purpose. This page is opened by a
 * person holding a slip of paper who wants to know what they owe, and every
 * additional element on it is something between them and that answer.
 *
 * Signing in with the reference alone is a decision the municipality took
 * knowingly; `referenceOnlyLoginSchema` records what it rests on and what it
 * gives up. The SMS route still exists at `/login` for anyone who would rather
 * use it, and the payments portal still asks for a phone alongside the number.
 */
export default function TenantHome({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}`;
  const tCitizen = useTranslations('citizen');

  const [reference, setReference] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in — go straight through rather than asking again.
  useEffect(() => {
    const session = loadSession(tenant);
    if (session?.user.kind === 'CITIZEN') router.replace(`${base}/my-file`);
  }, [tenant, base, router]);

  const complete = isCompleteReference(reference);

  const submit = useCallback(async () => {
    if (!isCompleteReference(reference) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await openByReference(tenant, formatReference(toRawReference(reference)));
      // Not remembered: a municipality's front door is opened on borrowed and
      // shared phones as often as on personal ones, so the session dies with
      // the tab rather than waiting there for whoever picks it up next.
      saveSession(tenant, session);
      router.replace(`${base}/my-file`);
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : (locale === 'en'
              ? 'Failed to open file. Please try again later.'
              : 'تعذّر فتح الملف. يرجى المحاولة لاحقاً.'),
      );
      setSubmitting(false);
    }
  }, [tenant, base, router, reference, submitting, locale]);

  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col justify-center space-y-6">
      <div className="space-y-3 text-center">
        <span
          aria-hidden
          className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary"
        >
          <FileSearch className="size-8" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {tCitizen('enterReference')}
        </h1>
        <p className="text-muted-foreground">
          {tCitizen('enterReferenceHint')}
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-6">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="space-y-2">
            <label htmlFor="reference" className="sr-only">
              {tCitizen('referenceNumber')}
            </label>
            <Input
              id="reference"
              dir="ltr"
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              maxLength={REFERENCE_RAW_LENGTH + 2}
              className="h-14 text-center font-mono text-base tracking-[0.15em] sm:h-16 sm:text-xl sm:tracking-[0.2em]"
              placeholder="BZR-2608-5HLQBM"
              value={reference}
              onChange={(event) => {
                setReference((previous) => nextReferenceValue(event.target.value, previous));
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
            />
          </div>

          <Button
            size="lg"
            className="w-full"
            disabled={!complete || submitting}
            onClick={() => void submit()}
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ArrowLeft className="size-4 rtl:rotate-0 ltr:rotate-180" aria-hidden />
            )}
            {tCitizen('viewMyFile')}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            {tCitizen('dontKnowReference')}{' '}
            <button
              type="button"
              onClick={() => router.push(`${base}/login`)}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {locale === 'en' ? 'Sign in with phone number' : 'سجّل الدخول برقم الهاتف'}
            </button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
