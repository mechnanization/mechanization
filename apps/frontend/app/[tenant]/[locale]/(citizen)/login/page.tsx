import { redirect } from 'next/navigation';

/**
 * The phone-code sign-in is retired (PAGE-03, decision U-21, 2026-11-24).
 *
 * No SMS provider is live (open-decisions §2, §21), so the code never arrived, and
 * the front door signs a citizen in by the رقم مرجعي. The address stays so a
 * bookmark or an old link still lands somewhere: «ملفّي», which sends a citizen
 * who is not signed in on to the front door. The API's OTP routes are untouched.
 */
export default async function CitizenLoginRetired({
  params,
}: {
  params: Promise<{ tenant: string; locale: string }>;
}) {
  const { tenant, locale } = await params;
  redirect(`/${tenant}/${locale}/my-file`);
}
