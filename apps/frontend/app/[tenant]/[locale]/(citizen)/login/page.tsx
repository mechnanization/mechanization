'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiRequestError, logApiError, requestOtp, verifyOtp } from '@/lib/api-client';
import type { CitizenChoice } from '@/lib/api-client';
import { saveSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { ChoiceCard, Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

type Stage = 'phone' | 'code' | 'choose';

/**
 * Citizen sign-in by phone OTP.
 *
 * Three things this page has to get right for its audience: a resend path that
 * actually changes something (the server switches SMS route on retry), a
 * disambiguation step for the household that shares one phone, and a visible
 * way out — the رقم مرجعي and the municipality counter — for the citizen whose
 * code never arrives at all.
 */
export default function CitizenLogin({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = use(params);
  const router = useRouter();

  const [stage, setStage] = useState<Stage>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [attempt, setAttempt] = useState(1);
  const [choices, setChoices] = useState<CitizenChoice[]>([]);
  const [chosenId, setChosenId] = useState<string>('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Counts down the resend button so the citizen sees that waiting is expected
  // rather than that the page is broken.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function send(nextAttempt: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await requestOtp(tenant, phone, nextAttempt);
      setAttempt(nextAttempt);

      // OTP is switched off server-side: there is no code coming, so asking
      // for one would strand the citizen on a screen nothing can satisfy.
      // Sign in directly — the same `verifyOtp` call, minus the code the
      // server is not checking.
      if (result.otpRequired === false) {
        await verify();
        return;
      }

      setStage('code');
      setDevCode(result.devCode ?? null);
      setCooldown(
        Math.max(
          0,
          Math.ceil((new Date(result.resendAvailableAt).getTime() - Date.now()) / 1000),
        ),
      );
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : (locale === 'en' ? 'Failed to send verification code.' : 'تعذّر إرسال الرمز.'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function verify(citizenId?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await verifyOtp(tenant, {
        phone,
        ...(code ? { code } : {}),
        citizenId,
      });

      if ('status' in result) {
        setChoices(result.choices);
        setStage('choose');
        return;
      }

      saveSession(tenant, result);
      router.push(`/${tenant}/${locale}/my-account`);
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : (locale === 'en' ? 'Failed to verify code.' : 'تعذّر التحقق من الرمز.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">
          {locale === 'en' ? 'Sign in to track my application' : 'الدخول لمتابعة طلبي'}
        </h1>
        <p className="text-muted-foreground">
          {locale === 'en' ? 'Sign in with your phone number — no password needed.' : 'ندخلك برقم هاتفك — لا حاجة لكلمة مرور.'}
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive"
        >
          {error}
        </p>
      ) : null}

      {stage === 'phone' ? (
        <div className="space-y-5">
          <Field label={locale === 'en' ? 'Phone Number' : 'رقم الهاتف'} htmlFor="phone" required>
            <Input
              id="phone"
              type="tel"
              inputMode="tel"
              placeholder="03 123456"
              className="text-start font-mono"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>

          <Button
            size="lg"
            className="w-full"
            disabled={busy || phone.trim().length < 7}
            onClick={() => send(1)}
          >
            {busy
              ? (locale === 'en' ? 'Sending code…' : 'جارٍ الإرسال…')
              : (locale === 'en' ? 'Send Code' : 'أرسل الرمز')}
          </Button>
        </div>
      ) : null}

      {stage === 'code' ? (
        <div className="space-y-5">
          <Field
            label={locale === 'en' ? 'Verification Code' : 'رمز التحقق'}
            htmlFor="code"
            required
          >
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              dir="ltr"
              maxLength={6}
              className="text-center text-2xl tracking-[0.5em]"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>

          {devCode ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
              {locale === 'en' ? 'Development Mode — Code: ' : 'وضع التطوير — الرمز: '}
              <span dir="ltr">{devCode}</span>
            </p>
          ) : null}

          <Button
            size="lg"
            className="w-full"
            disabled={busy || code.length !== 6}
            onClick={() => verify()}
          >
            {busy
              ? (locale === 'en' ? 'Verifying…' : 'جارٍ التحقق…')
              : (locale === 'en' ? 'Verify & Sign In' : 'تحقّق وادخل')}
          </Button>

          <Button
            variant="outline"
            size="lg"
            className="w-full"
            disabled={busy || cooldown > 0}
            onClick={() => send(attempt + 1)}
          >
            {cooldown > 0
              ? (locale === 'en' ? `Resend code in ${cooldown}s` : `إعادة الإرسال بعد ${cooldown} ثانية`)
              : (locale === 'en' ? 'Did not receive code? Resend' : 'لم يصلني الرمز — أعد الإرسال')}
          </Button>

          <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
            {locale === 'en'
              ? 'If you do not receive the code after multiple attempts, you can visit the municipality directly with your reference number to check your status.'
              : 'إذا لم يصلك الرمز بعد عدة محاولات، يمكنك مراجعة البلدية مباشرة مع رقمك المرجعي وسيتمكن الموظف من عرض حالة طلبك.'}
          </p>
        </div>
      ) : null}

      {stage === 'choose' ? (
        <div className="space-y-5">
          <p className="text-muted-foreground">
            {locale === 'en'
              ? 'This phone number is associated with multiple files. Choose your name to proceed.'
              : 'هذا الرقم مسجّل لأكثر من شخص. اختر اسمك للمتابعة.'}
          </p>

          <div className="grid gap-3">
            {choices.map((choice) => (
              <ChoiceCard
                key={choice.id}
                name="citizen"
                value={choice.id}
                checked={chosenId === choice.id}
                onChange={setChosenId}
                title={choice.displayName}
                description={
                  locale === 'en'
                    ? `ID document ends in ${choice.identityDocLastDigits}`
                    : `رقم الوثيقة ينتهي بـ ${choice.identityDocLastDigits}`
                }
              />
            ))}
          </div>

          <Button
            size="lg"
            className="w-full"
            disabled={busy || !chosenId}
            onClick={() => verify(chosenId)}
          >
            {locale === 'en' ? 'Continue' : 'متابعة'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
