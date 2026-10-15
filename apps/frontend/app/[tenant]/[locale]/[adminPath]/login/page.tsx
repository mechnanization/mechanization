'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  History,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { ApiRequestError, isTotpRequired, loginStaff, logApiError } from '@/lib/api-client';
import { openedAfterPasswordChange } from '@/lib/password-change';
import { loadSession, saveSession } from '@/lib/session';
import { defaultPathFor } from '@/components/admin/nav';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/states';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LanguageSwitcher } from '@/components/language-switcher';
import { useTranslations } from 'next-intl';

export default function StaffLogin({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const tAuth = useTranslations('auth');
  const tCommon = useTranslations('common');
  const t = useTranslations('auth.staffSignIn');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [totpToken, setTotpToken] = useState('');
  const [totpStage, setTotpStage] = useState(false);
  const [checking, setChecking] = useState(true);
  // Sent here by «تغيير كلمة المرور», which ended every session of the account.
  const [passwordChanged, setPasswordChanged] = useState(false);

  useEffect(() => {
    const session = loadSession(tenant);
    if (session && session.user.kind === 'STAFF') {
      router.replace(`/${tenant}/${locale}/${adminPath}${defaultPathFor(session.user.role)}`);
      return;
    }
    setPasswordChanged(openedAfterPasswordChange(window.location.search));
    setChecking(false);
  }, [tenant, locale, adminPath, router]);

  async function submit() {
    setBusy(true);
    setError(null);
    // Read once: the next attempt is about this sign-in, not the change behind it.
    setPasswordChanged(false);

    try {
      const result = await loginStaff(tenant, {
        email,
        password,
        remember: rememberMe,
        ...(totpStage && totpToken ? { totpToken } : {}),
      });

      if (isTotpRequired(result)) {
        setTotpStage(true);
        setTotpToken('');
        return;
      }

      saveSession(tenant, result, rememberMe);
      router.replace(
        `/${tenant}/${locale}/${adminPath}${defaultPathFor(result.user.role)}`,
      );
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError) {
        if (caught.status === 401) {
          if (totpStage) {
            setError(t('invalidCode'));
          } else {
            setError(t('invalidCredentials'));
          }
        } else {
          setError(caught.message);
        }
      } else {
        setError(t('failed'));
      }
      if (caught instanceof ApiRequestError && caught.status === 401 && !totpStage) {
        setTotpStage(false);
      }
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <LoadingState />
      </div>
    );
  }

  const guarantees = [
    {
      icon: Lock,
      title: tAuth('encryptedConnection'),
      desc: tAuth('encryptedDesc'),
    },
    {
      icon: ShieldCheck,
      title: tAuth('scopedPermissions'),
      desc: tAuth('scopedDesc'),
    },
    {
      icon: History,
      title: tAuth('auditLogged'),
      desc: tAuth('auditLoggedDesc'),
    },
  ];

  return (
    <div className="relative flex min-h-screen w-full bg-background text-foreground">
      {/* Left Column: Brand & Security Guarantees */}
      <aside className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-primary/95 p-12 lg:flex xl:p-16 text-primary-foreground">
        {/* Subtle decorative background patterns */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/25"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 -end-24 size-96 rounded-full bg-white/10 blur-3xl"
        />

        {/* Brand Header */}
        <div className="relative z-10 flex items-center gap-4">
          <img src="/logo.png" alt="" className="size-20 shrink-0 object-contain" aria-hidden />
          <div className="space-y-0.5">
            <span className="block text-lg font-bold font-display tracking-tight">
              {t('brand')}
            </span>
            <span className="block text-xs font-medium text-primary-foreground/80">
              {t('brandSub')}
            </span>
          </div>
        </div>

        {/* Center Information */}
        <div className="relative z-10 my-auto max-w-md py-10 space-y-8">
          <div className="space-y-3">
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl leading-snug">
              {t('portalTitle')}
            </h1>
            <p className="text-sm sm:text-base leading-relaxed text-primary-foreground/90">
              {t('portalDescription')}
            </p>
          </div>

          <ul className="space-y-5">
            {guarantees.map(({ icon: Icon, title, desc }) => (
              <li key={title} className="flex items-start gap-3">
                <Icon className="mt-0.5 size-5 shrink-0 text-primary-foreground" aria-hidden />
                <div className="space-y-0.5">
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="block text-xs sm:text-sm leading-relaxed text-primary-foreground/85">
                    {desc}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Bottom Footer Notice */}
        <div className="relative z-10 pt-4">
          <p className="text-xs text-primary-foreground/80">
            {t('footer')}
          </p>
        </div>
      </aside>

      {/* Right Column: Sign-in Form */}
      <main className="relative flex flex-1 flex-col justify-between px-6 py-10 sm:px-12 lg:px-16 xl:px-24">
        {/* Language Switcher in top corner */}
        <div className="flex w-full justify-end">
          <LanguageSwitcher currentLocale={locale} variant="dropdown" />
        </div>

        {/* Form Container */}
        <div className="my-auto mx-auto w-full max-w-[400px] py-8">
          {/* Mobile Logo Header */}
          <div className="mb-8 flex items-center gap-3.5 lg:hidden">
            <img src="/logo.png" alt="" className="size-16 shrink-0 object-contain" />
            <div className="space-y-0.5">
              <span className="block text-lg font-bold font-display">
                {t('brand')}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t('brandSub')}
              </span>
            </div>
          </div>

          <div className="mb-8 space-y-2">
            <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {totpStage
                ? tAuth('totpPrompt')
                : t('heading')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {totpStage
                ? tAuth('totpHolder')
                : tAuth('staffLoginDesc')}
            </p>
          </div>

          {passwordChanged && !error ? (
            <Alert variant="success" live="status" title={t('passwordChangedTitle')} className="mb-6">
              {t('passwordChangedBody')}
            </Alert>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="mb-6 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 text-sm leading-relaxed text-destructive animate-in fade-in-0 duration-200"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          ) : null}

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy) return;
              if (totpStage) {
                if (totpToken.length === 6) void submit();
                return;
              }
              if (email && password) void submit();
            }}
          >
            {totpStage ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="totp" className="text-sm font-medium">
                    {tAuth('totpPrompt')}
                  </Label>
                  <div className="relative">
                    <KeyRound
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 start-3.5 my-auto size-4 text-muted-foreground"
                    />
                    <Input
                      id="totp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      autoFocus
                      required
                      placeholder="••••••"
                      className="h-11 px-10 text-center font-mono text-xl tracking-[0.4em]"
                      value={totpToken}
                      onChange={(e) =>
                        setTotpToken(e.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                    />
                  </div>
                </div>

                <Button
                  type="submit"
                  className="h-11 w-full rounded-lg text-sm font-semibold shadow-sm cursor-pointer"
                  disabled={busy || totpToken.length !== 6}
                >
                  {busy ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      {tCommon('loading')}
                    </>
                  ) : (
                    tAuth('verifyCode')
                  )}
                </Button>

                <button
                  type="button"
                  onClick={() => {
                    setTotpStage(false);
                    setTotpToken('');
                    setPassword('');
                    setError(null);
                  }}
                  className="flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground pt-2 cursor-pointer"
                >
                  <ArrowRight className="size-3.5 rtl:rotate-0 ltr:rotate-180" aria-hidden />
                  {tCommon('back')}
                </button>
              </>
            ) : (
              <>
                {/* Email Field */}
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-sm font-medium">
                    {tAuth('email')}
                  </Label>
                  <div className="relative">
                    <Mail
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 start-3.5 my-auto size-4 text-muted-foreground"
                    />
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username"
                      autoFocus
                      required
                      placeholder="name@example.com"
                      className="h-11 ps-10 pe-4 text-start text-sm"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                </div>

                {/* Password Field */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password" className="text-sm font-medium">
                      {tAuth('password')}
                    </Label>
                  </div>
                  <div className="relative">
                    <Lock
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 start-3.5 my-auto size-4 text-muted-foreground"
                    />
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      placeholder="••••••••"
                      className="h-11 ps-10 pe-11 text-start text-sm"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((shown) => !shown)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                    >
                      {showPassword ? (
                        <EyeOff className="size-4" aria-hidden />
                      ) : (
                        <Eye className="size-4" aria-hidden />
                      )}
                    </button>
                  </div>
                </div>

                {/* Remember Me Checkbox */}
                <div className="flex items-center gap-2.5 pt-1">
                  <Checkbox
                    id="rememberMe"
                    checked={rememberMe}
                    onCheckedChange={(checked) => setRememberMe(checked === true)}
                  />
                  <Label
                    htmlFor="rememberMe"
                    className="cursor-pointer text-xs sm:text-sm font-normal text-muted-foreground select-none"
                  >
                    {tAuth('rememberMe')}
                  </Label>
                </div>

                {/* Submit Button */}
                <Button
                  type="submit"
                  className="mt-2 h-11 w-full rounded-lg text-sm font-semibold shadow-sm cursor-pointer"
                  disabled={busy || !email || !password}
                >
                  {busy ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      {tAuth('signingIn')}
                    </>
                  ) : (
                    tAuth('signIn')
                  )}
                </Button>
              </>
            )}
          </form>

          {/* Admin Help Footer */}
          <div className="mt-8 border-t border-border/70 pt-6 text-center text-xs text-muted-foreground leading-relaxed">
            <p>
              {t('help')}
            </p>
          </div>
        </div>

        {/* Mobile Footer */}
        <div className="text-center lg:hidden">
          <p className="text-xs text-muted-foreground">
            {t('footer')}
          </p>
        </div>
      </main>
    </div>
  );
}
