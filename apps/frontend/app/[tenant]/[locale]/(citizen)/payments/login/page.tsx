'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Receipt } from 'lucide-react';
import { ApiRequestError, loginByReference, logApiError } from '@/lib/api-client';
import { saveSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * Sign-in to the payments portal by رقم مرجعي.
 *
 * The phone is asked for alongside it, and that is not an oversight in the
 * spec's "reference number only" wording: the reference is printed on a
 * receipt and read aloud at a counter, so on its own it would open a record
 * holding a national ID number, a home address and a residency status. Two
 * facts that must agree is the weakest bar this data can sit behind, and it
 * costs the citizen one field they already know by heart.
 */
export default function PaymentsLogin({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = use(params);
  const router = useRouter();

  const [referenceNumber, setReferenceNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const session = await loginByReference(tenant, {
        referenceNumber: referenceNumber.trim(),
        phone: phone.trim(),
      });
      saveSession(tenant, session);
      router.push(`/${tenant}/${locale}/payments`);
    } catch (caught) {
      logApiError(caught);
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : (locale === 'en' ? 'Failed to sign in.' : 'تعذّر تسجيل الدخول.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const complete = referenceNumber.trim().length >= 4 && phone.trim().length >= 6;

  return (
    <div className="mx-auto max-w-md space-y-6 py-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Receipt className="size-7" aria-hidden />
        </div>
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">
            {locale === 'en' ? 'Fees & Payments' : 'الرسوم والمدفوعات'}
          </h1>
          <p className="text-muted-foreground">
            {locale === 'en'
              ? 'Enter your reference number and phone number to view your dues.'
              : 'ادخل برقمك المرجعي ورقم هاتفك لعرض مستحقاتك.'}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-5 p-6">
          {error ? (
            <Alert tone="error">
              {error}
            </Alert>
          ) : null}

          <Field
            label={locale === 'en' ? 'Reference Number' : 'الرقم المرجعي'}
            htmlFor="reference"
            required
          >
            <Input
              id="reference"
              className="text-start font-mono"
              placeholder="ABC-123456"
              value={referenceNumber}
              onChange={(event) => setReferenceNumber(event.target.value)}
            />
          </Field>

          <Field label={locale === 'en' ? 'Phone Number' : 'رقم الهاتف'} htmlFor="phone" required>
            <Input
              id="phone"
              type="tel"
              inputMode="tel"
              className="text-start font-mono"
              placeholder="03 123456"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </Field>

          <Button
            size="lg"
            className="w-full"
            disabled={!complete || busy}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {locale === 'en' ? 'Sign In' : 'دخول'}
          </Button>

          <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
            {locale === 'en'
              ? 'If you forgot your reference number, you can visit the municipality with your ID card to look it up.'
              : 'إذا نسيت رقمك المرجعي، يمكنك مراجعة البلدية مع هويتك وسيتمكن الموظف من استخراجه لك.'}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
