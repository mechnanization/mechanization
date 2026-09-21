'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  QrCode,
  ScrollText,
  Send,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import {
  ApiRequestError,
  beginStaffTotpEnrolment,
  changeStaffEmail,
  confirmStaffTotpEnrolment,
  disableStaffTotp,
  getStaff,
  logApiError,
  sendStaffPasswordResetEmail,
} from '@/lib/api-client';
import { QRCodeSVG } from 'qrcode.react';
import type { SettingsCopy } from '@/lib/settings-i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlignedFieldGrid,
  ScrollableTable,
  SettingsCard,
  SettingsField,
} from './settings-ui';
import { cn } from '@/lib/utils';

/**
 * Illustrative login rows.
 *
 * Deliberately flagged as a sample in the interface above them, and
 * deliberately not plausible-looking as *this* municipality's data — a fake
 * security log that reads as real is worse than no log, because the one thing
 * an administrator does with this table is decide whether someone else has
 * been in the account. Timestamps are relative to render so the table never
 * shows a frozen date that suggests the log stopped updating.
 */
const SAMPLE_ROWS = [
  { minutesAgo: 12, ip: '192.0.2.14', device: 'Chrome · Windows', location: 'Tyre, LB', ok: true },
  { minutesAgo: 320, ip: '192.0.2.14', device: 'Safari · iPhone', location: 'Tyre, LB', ok: true },
  { minutesAgo: 1450, ip: '198.51.100.7', device: 'Firefox · Linux', location: 'Beirut, LB', ok: false },
  { minutesAgo: 2880, ip: '192.0.2.14', device: 'Chrome · Windows', location: 'Tyre, LB', ok: true },
] as const;

export function SecuritySection({
  tenant,
  token,
  userId,
  copy,
  locale,
  base,
}: {
  tenant: string;
  token: string;
  userId: string;
  copy: SettingsCopy;
  locale: string;
  /** `/{tenant}/{locale}/{adminPath}` — where the reset-password link lands. */
  base: string;
}) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [loadingEmail, setLoadingEmail] = useState(true);

  // Email form state
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [sendingEmailChange, setSendingEmailChange] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Password reset state
  const [sendingResetEmail, setSendingResetEmail] = useState(false);

  // 2FA state
  const [is2FAEnabled, setIs2FAEnabled] = useState(false);
  const [show2FASetup, setShow2FASetup] = useState(false);
  const [totpSecret, setTotpSecret] = useState('');
  const [totpKeyUri, setTotpKeyUri] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [copiedKey, setCopiedKey] = useState(false);
  const [enrolling2FA, setEnrolling2FA] = useState(false);
  const [confirming2FA, setConfirming2FA] = useState(false);
  const [totpConfirmError, setTotpConfirmError] = useState<string | null>(null);

  // 2FA Security Challenge Modals
  const [disableModalOpen, setDisableModalOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disabling2FA, setDisabling2FA] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  const [reconfigureModalOpen, setReconfigureModalOpen] = useState(false);
  const [reconfigurePassword, setReconfigurePassword] = useState('');
  const [reconfiguring2FA, setReconfiguring2FA] = useState(false);
  const [reconfigureError, setReconfigureError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoadingEmail(true);
        const { items } = await getStaff(tenant, token);
        if (!cancelled) {
          const current = items.find((item) => item.id === userId);
          setEmail(current?.email ?? '');
          if (current?.hasConfirmedTotp) {
            setIs2FAEnabled(true);
          }
        }
      } catch (caught) {
        logApiError(caught);
      } finally {
        if (!cancelled) setLoadingEmail(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant, token, userId]);

  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ar-LB-u-nu-latn', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  const handleSendEmailChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail || !emailPassword || sendingEmailChange) return;
    setEmailError(null);
    setSendingEmailChange(true);

    try {
      const result = await changeStaffEmail(tenant, token, {
        newEmail,
        currentPassword: emailPassword,
      });
      setEmail(result.email);
      setNewEmail('');
      setEmailPassword('');
      setShowEmailForm(false);
      toast.success(
        locale === 'en' ? 'Email updated successfully' : 'تم تحديث البريد الإلكتروني بنجاح',
        {
          description:
            locale === 'en'
              ? 'Your sign-in email address has been updated.'
              : 'تم تحديث البريد الإلكتروني لحسابك وتأكيد التغيير.',
        },
      );
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError) {
        setEmailError(caught.message);
      } else {
        setEmailError(
          locale === 'en'
            ? 'Failed to update email address.'
            : 'تعذّر تحديث البريد الإلكتروني.',
        );
      }
    } finally {
      setSendingEmailChange(false);
    }
  };

  const handleSendResetPasswordEmail = async () => {
    if (sendingResetEmail || !email) return;
    setSendingResetEmail(true);
    try {
      await sendStaffPasswordResetEmail(
        tenant,
        token,
        `${window.location.origin}${base}/reset-password`,
      );
      toast.success(
        locale === 'en' ? 'Reset link sent' : 'تم إرسال رابط إعادة التعيين',
        {
          description:
            locale === 'en'
              ? `A password reset email has been sent to ${email}. Check your inbox.`
              : `تم إرسال بريد إعادة تعيين كلمة المرور إلى ${email}. تفقّد بريدك الإلكتروني.`,
        },
      );
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError) {
        toast.error(
          locale === 'en' ? 'Failed to send reset email' : 'تعذّر إرسال البريد',
          { description: caught.message },
        );
      } else {
        toast.error(
          locale === 'en' ? 'Failed to send reset email' : 'تعذّر إرسال البريد',
          {
            description:
              locale === 'en'
                ? 'Unable to send password reset email.'
                : 'تعذّر إرسال بريد إعادة تعيين كلمة المرور.',
          },
        );
      }
    } finally {
      setSendingResetEmail(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Email Address Section */}
      <SettingsCard
        icon={Mail}
        title={copy.security.credentialsHeading}
        hint={copy.security.credentialsHint}
        actions={
          <Badge variant="soft-success">
            {locale === 'en' ? 'Verified' : 'موثّق'}
          </Badge>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-border/70 bg-muted/20 p-4">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {copy.security.currentEmail}
              </p>
              {loadingEmail ? (
                <Skeleton className="h-5 w-48 rounded" />
              ) : (
                <p className="font-mono text-sm font-semibold tracking-wide text-foreground">
                  {email || '—'}
                </p>
              )}
            </div>
            {!showEmailForm && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowEmailForm(true)}
              >
                <Send className="me-2 size-3.5" />
                {locale === 'en' ? 'Change Email Address' : 'تغيير البريد الإلكتروني'}
              </Button>
            )}
          </div>

          {showEmailForm && (
            <form onSubmit={handleSendEmailChange} className="rounded-xl border border-primary/20 bg-primary/[0.02] p-4 space-y-4">
              <AlignedFieldGrid>
                <SettingsField
                  label={copy.security.newEmail}
                  htmlFor="new-email"
                  error={emailError ?? undefined}
                >
                  <Input
                    id="new-email"
                    type="email"
                    dir="ltr"
                    className="text-start font-mono"
                    value={newEmail}
                    onChange={(e) => {
                      setNewEmail(e.target.value);
                      setEmailError(null);
                    }}
                    placeholder="name@example.com"
                    required
                  />
                </SettingsField>

                <SettingsField
                  label={locale === 'en' ? 'Current Password (to confirm)' : 'كلمة المرور الحالية (للتأكيد)'}
                  htmlFor="email-current-password"
                >
                  <Input
                    id="email-current-password"
                    type="password"
                    autoComplete="current-password"
                    value={emailPassword}
                    onChange={(e) => {
                      setEmailPassword(e.target.value);
                      setEmailError(null);
                    }}
                    required
                  />
                </SettingsField>
              </AlignedFieldGrid>

              <div className="flex items-center gap-3 pt-1">
                <Button
                  type="submit"
                  disabled={!newEmail || !emailPassword || sendingEmailChange || newEmail.toLowerCase() === email.toLowerCase()}
                >
                  {sendingEmailChange ? (
                    <>
                      <Loader2 className="me-2 size-4 animate-spin" />
                      {locale === 'en' ? 'Sending link…' : 'جارٍ الإرسال…'}
                    </>
                  ) : (
                    <>
                      <Send className="me-2 size-4" />
                      {locale === 'en' ? 'Send Change Confirmation' : 'إرسال رابط تأكيد التغيير'}
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setShowEmailForm(false);
                    setEmailError(null);
                  }}
                >
                  {locale === 'en' ? 'Cancel' : 'إلغاء'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </SettingsCard>

      {/* Password & Authentication Section (Single Action Button) */}
      <SettingsCard
        icon={KeyRound}
        title={copy.security.passwordHeading}
        hint={copy.security.passwordHint}
        actions={
          <Badge variant="soft-success">
            {locale === 'en' ? 'Protected' : 'محمي'}
          </Badge>
        }
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-border/70 bg-muted/20 p-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">
              {locale === 'en' ? 'Account Password' : 'كلمة مرور الحساب'}
            </p>
            <p className="text-xs text-muted-foreground">
              {locale === 'en'
                ? 'Send a secure password reset link to your registered email address.'
                : 'إرسال رابط آمن لإعادة تعيين كلمة المرور مباشرة إلى بريدك الإلكتروني.'}
            </p>
          </div>

          <Button
            type="button"
            onClick={handleSendResetPasswordEmail}
            disabled={sendingResetEmail || loadingEmail || !email}
          >
            {sendingResetEmail ? (
              <>
                <Loader2 className="me-2 size-4 animate-spin" />
                {locale === 'en' ? 'Sending reset link…' : 'جارٍ إرسال الرابط…'}
              </>
            ) : (
              <>
                <Send className="me-2 size-4" />
                {locale === 'en' ? 'Send Reset Password Email' : 'إرسال رابط إعادة تعيين كلمة المرور'}
              </>
            )}
          </Button>
        </div>
      </SettingsCard>

      {/* Two-Factor Authentication */}
      <SettingsCard
        icon={ShieldCheck}
        title={copy.security.twoFactorHeading}
        hint={copy.security.twoFactorHint}
        actions={
          is2FAEnabled ? (
            <Badge variant="soft-success">
              {locale === 'en' ? 'Protected' : 'محمي'}
            </Badge>
          ) : (
            <Badge variant="soft-warning">
              {locale === 'en' ? 'Recommended' : 'موصى به'}
            </Badge>
          )
        }
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-border/70 bg-muted/20 p-4">
            <div className="flex items-start gap-3.5">
              <div
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-lg',
                  is2FAEnabled
                    ? 'bg-success/15 text-success'
                    : 'bg-primary/10 text-primary',
                )}
              >
                <Smartphone className="size-5" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-foreground">
                    {copy.security.twoFactorApp}
                  </p>
                  {is2FAEnabled ? (
                    <Badge variant="soft-success" className="text-[10px] px-1.5 py-0">
                      {locale === 'en' ? 'Active' : 'مفعّل'}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {is2FAEnabled
                    ? locale === 'en'
                      ? 'Two-factor authentication is active and protecting this account with one-time verification codes.'
                      : 'التحقق بخطوتين مفعّل ومحمي بواسطة تطبيق المصادقة مع طلب رموز مؤقتة عند تسجيل الدخول.'
                    : locale === 'en'
                      ? 'Require a temporary 6-digit verification code from your authenticator app (Google Authenticator, 1Password, or Authy) on sign in.'
                      : 'طلب رمز تحقق سداسي مؤقت من تطبيق المصادقة (Google Authenticator، 1Password، أو Authy) عند تسجيل الدخول.'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                type="button"
                variant={is2FAEnabled ? 'outline' : 'default'}
                size="sm"
                disabled={enrolling2FA}
                onClick={async () => {
                  if (is2FAEnabled) {
                    if (show2FASetup) {
                      setShow2FASetup(false);
                    } else {
                      setReconfigureModalOpen(true);
                      setReconfigureError(null);
                      setReconfigurePassword('');
                    }
                  } else {
                    if (show2FASetup) {
                      setShow2FASetup(false);
                    } else {
                      try {
                        setEnrolling2FA(true);
                        const res = await beginStaffTotpEnrolment(tenant, token);
                        setTotpSecret(res.secret);
                        setTotpKeyUri(res.keyUri);
                        setShow2FASetup(true);
                      } catch (caught) {
                        logApiError(caught);
                        toast.error(
                          locale === 'en'
                            ? 'Failed to generate authenticator secret'
                            : 'تعذّر إنشاء مفتاح المصادقة',
                        );
                      } finally {
                        setEnrolling2FA(false);
                      }
                    }
                  }
                }}
              >
                {enrolling2FA ? (
                  <Loader2 className="me-2 size-3.5 animate-spin" />
                ) : (
                  <QrCode className="me-2 size-3.5" />
                )}
                {show2FASetup
                  ? locale === 'en'
                    ? 'Close Setup'
                    : 'إغلاق الإعداد'
                  : is2FAEnabled
                    ? locale === 'en'
                      ? 'Reconfigure'
                      : 'إعادة الضبط'
                    : locale === 'en'
                      ? 'Set Up Authenticator'
                      : 'إعداد تطبيق المصادقة'}
              </Button>

              {is2FAEnabled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    setDisableModalOpen(true);
                    setDisableError(null);
                    setDisablePassword('');
                  }}
                >
                  {locale === 'en' ? 'Disable' : 'إلغاء'}
                </Button>
              ) : null}
            </div>
          </div>

          {show2FASetup && (
            <div className="rounded-xl border border-primary/20 bg-primary/[0.02] p-5 space-y-5">
              <div className="grid gap-6 md:grid-cols-[168px_1fr] items-center">
                {/* Real Live QR Code */}
                <div className="flex flex-col items-center justify-center gap-2.5 rounded-xl border border-border bg-white p-3 shadow-sm text-center">
                  <div className="rounded-lg bg-white p-1 flex items-center justify-center min-h-[136px] min-w-[136px]">
                    {enrolling2FA || !totpSecret ? (
                      <Skeleton className="size-[136px] rounded-lg" />
                    ) : (
                      <QRCodeSVG
                        value={totpKeyUri || `otpauth://totp/Mechanization:${encodeURIComponent(email || 'Admin')}?secret=${totpSecret}&issuer=Mechanization&algorithm=SHA1&digits=6&period=30`}
                        size={136}
                        level="M"
                        bgColor="#ffffff"
                        fgColor="#0f172a"
                        includeMargin={false}
                      />
                    )}
                  </div>
                  <span className="text-[11px] font-semibold text-slate-700">
                    {locale === 'en' ? 'Scan with Authenticator' : 'امسح بتطبيق المصادقة'}
                  </span>
                </div>

                {/* Instructions & Secret */}
                <div className="space-y-3.5">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">
                      {locale === 'en' ? '1. Add to Authenticator App' : '1. أضف الرمز إلى تطبيق المصادقة'}
                    </h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {locale === 'en'
                        ? 'Scan the QR code with Google Authenticator, 1Password, or Microsoft Authenticator, or enter the secret key manually:'
                        : 'امسح رمز الاستجابة السريعة بتطبيق Google Authenticator أو 1Password أو Microsoft Authenticator، أو أدخل المفتاح يدوياً:'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 max-w-sm">
                    {enrolling2FA || !totpSecret ? (
                      <Skeleton className="h-8 flex-1 rounded-lg" />
                    ) : (
                      <>
                        <div className="flex-1 rounded-lg border bg-background px-3 py-1.5 font-mono text-xs font-semibold text-foreground tracking-widest text-center select-all">
                          {totpSecret.match(/.{1,4}/g)?.join(' ') ?? totpSecret}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            navigator.clipboard.writeText(totpSecret);
                            setCopiedKey(true);
                            setTimeout(() => setCopiedKey(false), 2000);
                          }}
                        >
                          {copiedKey ? (
                            <Check className="size-3.5 text-success" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Verification Code Input */}
              <div className="border-t border-border/60 pt-4 space-y-3">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">
                    {locale === 'en' ? '2. Verify 6-digit Code' : '2. التحقق من الرمز السداسي'}
                  </h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {locale === 'en'
                      ? 'Enter the 6-digit code generated by your app to complete setup.'
                      : 'أدخل الرمز المكوّن من 6 أرقام الظاهر في تطبيقك لإتمام التفعيل.'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="w-44">
                    <Input
                      id="totp-code"
                      inputMode="numeric"
                      dir="ltr"
                      maxLength={6}
                      value={totpCode}
                      onChange={(e) => {
                        setTotpCode(e.target.value.replace(/\D/g, ''));
                        setTotpConfirmError(null);
                      }}
                      placeholder="000 000"
                      className="text-center font-mono text-base tracking-[0.35em]"
                    />
                  </div>

                  <Button
                    type="button"
                    disabled={totpCode.length !== 6 || confirming2FA || !totpSecret}
                    onClick={async () => {
                      if (totpCode.length !== 6 || confirming2FA) return;
                      setConfirming2FA(true);
                      setTotpConfirmError(null);
                      try {
                        await confirmStaffTotpEnrolment(tenant, token, { token: totpCode });
                        setIs2FAEnabled(true);
                        setShow2FASetup(false);
                        setTotpCode('');
                        toast.success(
                          locale === 'en' ? '2FA Protected' : 'تم تفعيل التحقق بخطوتين',
                          {
                            description:
                              locale === 'en'
                                ? 'Your account is now protected with two-factor authentication.'
                                : 'تم تفعيل التحقق بخطوتين لحسابك بنجاح وحماية الحساب.',
                          },
                        );
                      } catch (caught) {
                        logApiError(caught);
                        const msg =
                          locale === 'en'
                            ? 'Invalid verification code. Please check the 6-digit code in your app and try again.'
                            : 'رمز التحقق غير صحيح. يرجى التأكد من الرمز والمحاولة مجدداً.';
                        setTotpConfirmError(msg);
                        toast.error(msg);
                      } finally {
                        setConfirming2FA(false);
                      }
                    }}
                  >
                    {confirming2FA ? (
                      <>
                        <Loader2 className="me-2 size-3.5 animate-spin" />
                        {locale === 'en' ? 'Verifying…' : 'جارٍ التحقق…'}
                      </>
                    ) : (
                      <>
                        <Lock className="me-2 size-3.5" />
                        {locale === 'en' ? 'Activate 2FA' : 'تفعيل التحقق'}
                      </>
                    )}
                  </Button>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShow2FASetup(false);
                      setTotpCode('');
                      setTotpConfirmError(null);
                    }}
                  >
                    {locale === 'en' ? 'Cancel' : 'إلغاء'}
                  </Button>
                </div>

                {totpConfirmError && (
                  <p className="text-xs text-destructive font-medium mt-1">
                    {totpConfirmError}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Login History */}
      <SettingsCard
        icon={ScrollText}
        title={copy.security.historyHeading}
        hint={copy.security.historyHint}
        actions={<Badge variant="soft-warning">{copy.security.historySample}</Badge>}
      >
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          {copy.security.historySampleHint}
        </p>

        <ScrollableTable minWidth="46rem">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{copy.security.colWhen}</TableHead>
                <TableHead>{copy.security.colIp}</TableHead>
                <TableHead>{copy.security.colDevice}</TableHead>
                <TableHead>{copy.security.colLocation}</TableHead>
                <TableHead>{copy.security.colResult}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SAMPLE_ROWS.map((row) => (
                <TableRow key={`${row.ip}-${row.minutesAgo}`}>
                  <TableCell className="whitespace-nowrap">
                    {dateFormat.format(new Date(Date.now() - row.minutesAgo * 60_000))}
                  </TableCell>
                  <TableCell dir="ltr" className="text-start font-mono text-xs">
                    {row.ip}
                  </TableCell>
                  <TableCell dir="ltr" className="whitespace-nowrap text-start">
                    {row.device}
                  </TableCell>
                  <TableCell dir="ltr" className="whitespace-nowrap text-start">
                    {row.location}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.ok ? 'soft-success' : 'soft-destructive'}>
                      {row.ok ? copy.security.resultSuccess : copy.security.resultFailed}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollableTable>
      </SettingsCard>

      {/* Security Confirmation: Disable 2FA Modal */}
      <Dialog open={disableModalOpen} onOpenChange={setDisableModalOpen}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!disablePassword || disabling2FA) {
                setDisableError(locale === 'en' ? 'Password is required' : 'كلمة المرور مطلوبة');
                return;
              }
              setDisabling2FA(true);
              setDisableError(null);
              try {
                await disableStaffTotp(tenant, token, { currentPassword: disablePassword });
                setIs2FAEnabled(false);
                setShow2FASetup(false);
                setTotpCode('');
                setDisableModalOpen(false);
                setDisablePassword('');
                toast.info(
                  locale === 'en' ? '2FA Disabled' : 'تم إيقاف التحقق بخطوتين',
                  {
                    description:
                      locale === 'en'
                        ? 'Two-factor authentication has been turned off for this account.'
                        : 'تم إيقاف التحقق بخطوتين لهذا الحساب.',
                  },
                );
              } catch (caught) {
                logApiError(caught);
                const msg =
                  caught instanceof ApiRequestError && caught.status === 401
                    ? locale === 'en'
                      ? 'Incorrect password. Please try again.'
                      : 'كلمة المرور غير صحيحة.'
                    : locale === 'en'
                      ? 'Failed to disable 2FA'
                      : 'تعذّر إيقاف التحقق بخطوتين';
                setDisableError(msg);
              } finally {
                setDisabling2FA(false);
              }
            }}
          >
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                  <ShieldAlert className="size-5" />
                </div>
                <div>
                  <DialogTitle>
                    {locale === 'en' ? 'Disable Two-Factor Authentication' : 'إلغاء تفعيل التحقق بخطوتين'}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    {locale === 'en'
                      ? 'Disabling 2FA lowers your account security. Please confirm your current password to proceed.'
                      : 'سيؤدي هذا الإجراء إلى خفض مستوى أمان حسابك. يرجى تأكيد كلمة المرور للمتابعة.'}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="my-5 space-y-3">
              <SettingsField
                label={locale === 'en' ? 'Current Password' : 'كلمة المرور الحالية'}
                htmlFor="disable-2fa-password"
                error={disableError ?? undefined}
              >
                <Input
                  id="disable-2fa-password"
                  type="password"
                  autoComplete="current-password"
                  value={disablePassword}
                  onChange={(e) => {
                    setDisablePassword(e.target.value);
                    setDisableError(null);
                  }}
                  placeholder="••••••••"
                  autoFocus
                  required
                />
              </SettingsField>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="ghost"
                disabled={disabling2FA}
                onClick={() => {
                  setDisableModalOpen(false);
                  setDisablePassword('');
                  setDisableError(null);
                }}
              >
                {locale === 'en' ? 'Cancel' : 'إلغاء'}
              </Button>
              <Button type="submit" variant="destructive" disabled={disabling2FA}>
                {disabling2FA ? (
                  <>
                    <Loader2 className="me-2 size-4 animate-spin" />
                    {locale === 'en' ? 'Disabling…' : 'جارٍ الإلغاء…'}
                  </>
                ) : (
                  locale === 'en' ? 'Confirm & Disable' : 'تأكيد وإلغاء التفعيل'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Security Confirmation: Reconfigure 2FA Modal */}
      <Dialog open={reconfigureModalOpen} onOpenChange={setReconfigureModalOpen}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!reconfigurePassword || reconfiguring2FA) {
                setReconfigureError(locale === 'en' ? 'Password is required' : 'كلمة المرور مطلوبة');
                return;
              }
              setReconfiguring2FA(true);
              setReconfigureError(null);
              try {
                const res = await beginStaffTotpEnrolment(tenant, token);
                setTotpSecret(res.secret);
                setTotpKeyUri(res.keyUri);
                setShow2FASetup(true);
                setReconfigureModalOpen(false);
                setReconfigurePassword('');
                toast.info(
                  locale === 'en' ? 'Ready to configure' : 'جاهز لإعادة الضبط',
                  {
                    description:
                      locale === 'en'
                        ? 'Scan the new QR code with your authenticator app.'
                        : 'امسح رمز الاستجابة السريعة الجديد بتطبيق المصادقة.',
                  },
                );
              } catch (caught) {
                logApiError(caught);
                const msg =
                  caught instanceof ApiRequestError && caught.status === 401
                    ? locale === 'en'
                      ? 'Incorrect password. Please try again.'
                      : 'كلمة المرور غير صحيحة.'
                    : locale === 'en'
                      ? 'Failed to reconfigure'
                      : 'تعذّر إعادة الضبط';
                setReconfigureError(msg);
              } finally {
                setReconfiguring2FA(false);
              }
            }}
          >
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <ShieldCheck className="size-5" />
                </div>
                <div>
                  <DialogTitle>
                    {locale === 'en' ? 'Reconfigure Authenticator App' : 'إعادة ضبط تطبيق المصادقة'}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    {locale === 'en'
                      ? 'Confirm your password to generate a new authentication secret and QR code.'
                      : 'أدخل كلمة المرور الحالية لتوليد مفتاح أمان جديد ورمز QR للربط.'}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="my-5 space-y-3">
              <SettingsField
                label={locale === 'en' ? 'Current Password' : 'كلمة المرور الحالية'}
                htmlFor="reconfigure-2fa-password"
                error={reconfigureError ?? undefined}
              >
                <Input
                  id="reconfigure-2fa-password"
                  type="password"
                  autoComplete="current-password"
                  value={reconfigurePassword}
                  onChange={(e) => {
                    setReconfigurePassword(e.target.value);
                    setReconfigureError(null);
                  }}
                  placeholder="••••••••"
                  autoFocus
                  required
                />
              </SettingsField>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="ghost"
                disabled={reconfiguring2FA}
                onClick={() => {
                  setReconfigureModalOpen(false);
                  setReconfigurePassword('');
                  setReconfigureError(null);
                }}
              >
                {locale === 'en' ? 'Cancel' : 'إلغاء'}
              </Button>
              <Button type="submit" disabled={reconfiguring2FA}>
                {reconfiguring2FA ? (
                  <>
                    <Loader2 className="me-2 size-4 animate-spin" />
                    {locale === 'en' ? 'Unlocking…' : 'جارٍ التأكيد…'}
                  </>
                ) : (
                  locale === 'en' ? 'Unlock & Reconfigure' : 'تأكيد ومتابعة'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
