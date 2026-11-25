'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown, FileBarChart, FileWarning, History, Megaphone, Plus, ShieldCheck, UserPlus, type LucideIcon } from 'lucide-react';
import { navLabel } from '@/components/admin/nav';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/**
 * What the fees page's header offers (PAGE-04, the page contract's item 2).
 *
 * It was eight controls in a row for a manager, and «إصدار رسم جديد», the page's
 * job, was off-screen at 360px. Now one primary action and first in reading order
 * («إصدار رسم جديد»), one secondary («تكليف مباشر»), and the pages around the
 * ledger in one «المزيد» menu (PRIM-26). Each of those stays behind the role
 * check it had, so a role that may read none of the optional ones sees «إشعارات
 * الرسوم» alone, which every ledger reader may.
 *
 * No «تحديث»: the page reads through `useStaffQuery`, and a write invalidates what
 * it moved, so a button that re-runs a read by hand is the stale-data habit the
 * data rule retires.
 */
export function FeesHeaderActions({
  base,
  locale,
  canIssue,
  onDirectCharge,
  canReadCorrections,
  canReadExemptions,
  canPrepareArrears,
  canReadArrearsReport,
}: {
  base: string;
  locale: string;
  /** `FEE_ISSUE_ROLES`: a new fee and a direct charge. */
  canIssue: boolean;
  onDirectCharge: () => void;
  /** `PAYMENT_REVIEW_READ_ROLES`. */
  canReadCorrections: boolean;
  /** `FEE_EXEMPTION_READ_ROLES`: the list names the people on each unit. */
  canReadExemptions: boolean;
  /** `ARREARS_PREPARE_ROLES`. */
  canPrepareArrears: boolean;
  /** `ARREARS_REPORT_ROLES`: sums only, no citizen, so every finance reader. */
  canReadArrearsReport: boolean;
}): React.JSX.Element {
  const t = useTranslations('fees.header');
  const tNotices = useTranslations('fees.notices');
  const tExemptions = useTranslations('feeExemptions');
  const tArrears = useTranslations('arrears');

  const links: Array<{ show: boolean; href: string; icon: LucideIcon; label: string }> = [
    // «فواتير تأثّرت بتصحيحات»: reached from here only since NAV-07.
    { show: canReadCorrections, href: '/fees/corrections', icon: FileWarning, label: navLabel('feeCorrections', locale) },
    // «إشعارات الرسوم»: every notice issued, and the manager's «إلغاء الإشعار». Read by every ledger reader.
    { show: true, href: '/fees/notices', icon: Megaphone, label: tNotices('title') },
    { show: canReadExemptions, href: '/fees/exemptions', icon: ShieldCheck, label: tExemptions('link') },
    { show: canPrepareArrears, href: '/fees/arrears', icon: History, label: tArrears('link') },
    { show: canReadArrearsReport, href: '/fees/arrears/report', icon: FileBarChart, label: tArrears('report.link') },
  ];

  return (
    <>
      {canIssue ? (
        <>
          <Button asChild size="sm">
            <Link href={`${base}/fees/new`}>
              <Plus className="size-4" aria-hidden />
              {t('issue')}
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={onDirectCharge}>
            <UserPlus className="size-4" aria-hidden />
            {t('directCharge')}
          </Button>
        </>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {t('more')}
            <ChevronDown className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {links
            .filter((link) => link.show)
            .map((link) => (
              <DropdownMenuItem key={link.href} asChild className="min-h-10">
                <Link href={`${base}${link.href}`}>
                  <link.icon className="size-4" aria-hidden />
                  {link.label}
                </Link>
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
