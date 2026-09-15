import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'السجل البلدي — منصة العقارات والوحدات السكنية',
  description: 'النظام الرسمي لتسجيل وحصر العقارات والوحدات السكنية للبلديات اللبنانية',
};

/**
 * `viewportFit: 'cover'` is the line that makes the rest of the app's phone
 * layout real.
 *
 * Without it iOS letterboxes the page above the home indicator and reports
 * every `env(safe-area-inset-*)` as 0 — so the careful
 * `pb-[max(0.875rem,env(safe-area-inset-bottom))]` on the wizard's mobile
 * action bar was padding by 0.875rem and nothing more, and the «حفظ» button sat
 * under the indicator anyway. One declaration here, and every safe-area rule in
 * the portal starts meaning what it says.
 *
 * `maximumScale` is deliberately not set: capping zoom on a register of
 * national ID numbers and addresses would stop anyone who needs to enlarge
 * text from reading it.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}

