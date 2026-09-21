'use client';

import { use, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ApiRequestError, confirmStaffPasswordReset, logApiError } from '@/lib/api-client';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LanguageSwitcher } from '@/components/language-switcher';
import { LoadingState } from '@/components/ui/states';

type ParsedLink =
  | { kind: 'recovery'; accessToken: string }
  | { kind: 'email_change' }
  | { kind: 'invalid' };

/**
 * Reads the token Supabase's own `/auth/v1/verify` redirect appends to this
 * page's URL fragment.
 *
 * Not a query string: GoTrue's classic (non-PKCE) flow puts the session in
 * the hash specifically so it never reaches a server access log. `type`
 * tells the two links this page has to handle apart — `recovery` from
 * "send-reset-password-email", `email_change` from Supabase's own automatic
 * notification when a staff member's email changes.
 */
function parseAuthHash(hash: string): ParsedLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const type = params.get('type');
  const accessToken = params.get('access_token');

  if (type?.startsWith('email_change')) return { kind: 'email_change' };
  if (type === 'recovery' && accessToken) return { kind: 'recovery', accessToken };
  return { kind: 'invalid' };
}

/**
 * Where every "send-reset-password-email" and Supabase's own email-change
 * notification land — see `SecuritySection.handleSendResetPasswordEmail`.
 *
 * Reached with no session: whoever clicked the email link may not be signed
 * in on this device at all, so this route lives beside `login`, outside
 * `(protected)`.
 */
export default function ResetPasswordPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const tAuth = useTranslations('auth');

  const [link, setLink] = useState<ParsedLink | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setLink(parseAuthHash(window.location.hash));
    // The token is single-use proof of identity — stripped from the address
    // bar and history the moment it is read, rather than left sitting there
    // for a shared computer's next user or a screenshot to pick up.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit() {
    if (link?.kind !== 'recovery') return;
    if (password.length < 10) {
      setError(tAuth('passwordTooShort'));
      return;
    }
    if (password !== confirmPassword) {
      setError(tAuth('passwordsDontMatch'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await confirmStaffPasswordReset(tenant, link.accessToken, password);
      setDone(true);
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : locale === 'en'
            ? 'Unable to set password.'
            : 'تعذّر تعيين كلمة المرور.',
      );
    } finally {
      setBusy(false);
    }
  }

  const loginHref = `/${tenant}/${locale}/${adminPath}/login`;

  if (link === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <LoadingState />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="absolute top-6 end-6">
        <LanguageSwitcher currentLocale={locale} variant="dropdown" />
      </div>

      <div className="w-full max-w-[400px]">
        <div
          aria-hidden
          className="mx-auto mb-7 flex size-14 items-center justify-center"
        >
          <img src="/logo.png" alt="" className="size-14 object-contain" />
        </div>

        {link.kind === 'invalid' ? (
          <div className="space-y-2.5 text-center">
            <AlertCircle className="mx-auto size-8 text-destructive" aria-hidden />
            <h1 className="font-display text-2xl font-bold tracking-tight">
              {tAuth('invalidResetLinkTitle')}
            </h1>
            <p className="text-muted-foreground">{tAuth('invalidResetLinkDesc')}</p>
            <a href={loginHref} className={buttonVariants({ className: 'mt-4' })}>
              {tAuth('goToSignIn')}
            </a>
          </div>
        ) : link.kind === 'email_change' ? (
          <div className="space-y-2.5 text-center">
            <CheckCircle2 className="mx-auto size-8 text-success" aria-hidden />
            <h1 className="font-display text-2xl font-bold tracking-tight">
              {tAuth('emailChangeConfirmedTitle')}
            </h1>
            <p className="text-muted-foreground">{tAuth('emailChangeConfirmedDesc')}</p>
            <a href={loginHref} className={buttonVariants({ className: 'mt-4' })}>
              {tAuth('goToSignIn')}
            </a>
          </div>
        ) : done ? (
          <div className="space-y-2.5 text-center">
            <CheckCircle2 className="mx-auto size-8 text-success" aria-hidden />
            <h1 className="font-display text-2xl font-bold tracking-tight">
              {tAuth('passwordUpdatedTitle')}
            </h1>
            <p className="text-muted-foreground">{tAuth('passwordUpdatedDesc')}</p>
            <a href={loginHref} className={buttonVariants({ className: 'mt-4' })}>
              {tAuth('goToSignIn')}
            </a>
          </div>
        ) : (
          <>
            <div className="mb-9 space-y-2.5 text-center">
              <h1 className="font-display text-2xl font-bold tracking-tight">
                {tAuth('resetPasswordTitle')}
              </h1>
              <p className="text-muted-foreground">{tAuth('resetPasswordDesc')}</p>
            </div>

            {error ? (
              <p
                role="alert"
                className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{error}</span>
              </p>
            ) : null}

            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void submit();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="new-password">{tAuth('newPassword')}</Label>
                <div className="relative">
                  <Lock
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 start-3.5 my-auto size-4 text-muted-foreground"
                  />
                  <Input
                    id="new-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoFocus
                    required
                    minLength={10}
                    placeholder="••••••••••"
                    className="ps-10 pe-11 text-start"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((shown) => !shown)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-md text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPassword ? (
                      <EyeOff className="size-5" aria-hidden />
                    ) : (
                      <Eye className="size-5" aria-hidden />
                    )}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-password">{tAuth('confirmPassword')}</Label>
                <div className="relative">
                  <Lock
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 start-3.5 my-auto size-4 text-muted-foreground"
                  />
                  <Input
                    id="confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    minLength={10}
                    placeholder="••••••••••"
                    className="ps-10 pe-4 text-start"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
              </div>

              <Button
                type="submit"
                className="h-12 w-full rounded-lg text-base font-semibold shadow-sm"
                disabled={busy || !password || !confirmPassword}
              >
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {tAuth('settingPassword')}
                  </>
                ) : (
                  tAuth('setNewPassword')
                )}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
