'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CloudOff, ExternalLink, UsersRound } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { listCitizens, logApiError, type CitizenListItem } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';

const DEBOUNCE_MS = 500;
const MAX_SHOWN = 5;

/**
 * «قد يكون مسجَّلاً مسبقاً» — people already on file who match what is being typed.
 *
 * ## Why this exists now
 *
 * The identity document used to be what recognised a returning person, and it
 * did so by *merging*: a repeated number wrote the new filing over the old
 * citizen. That merge is gone (a filing never overwrites anyone), and so is the
 * document for a Lebanese citizen. What is left to recognise a duplicate is a
 * person looking at a name and a phone number — so the form shows them the
 * matches while they type, rather than after a second record exists.
 *
 * It only ever **shows**. Nothing is linked or merged from here: a phone is
 * shared by a household and a name by cousins, so the officer opens the match
 * (in a new tab, so the form in progress survives) and decides. Registering the
 * same person again is recoverable; merging two people is not.
 *
 * ## What makes a row decidable
 *
 * اسم الأم وشهرتها, since migration 0044. Two «محمد خليل»s with a shared
 * household line were, until then, two rows this panel could show and nobody
 * could choose between — which is the failure mode of a warning that cannot be
 * acted on: it gets dismissed on the tenth record, including the one where it
 * was right.
 *
 * Printed only where the register holds it. A «والدته: —» beside a row that
 * names a mother reads as a difference between two people, when all it records
 * is that one file was opened before the field existed.
 */
export function PossibleDuplicates({
  tenant,
  token,
  firstName,
  lastName,
  phone,
  whatsapp,
  locale,
}: {
  tenant: string;
  token: string | null | undefined;
  firstName: unknown;
  lastName: unknown;
  phone: unknown;
  /** The WhatsApp number, only when it is a different number from `phone`. */
  whatsapp?: unknown;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const pathname = usePathname();
  const [matches, setMatches] = useState<CitizenListItem[]>([]);
  /**
   * The lookup could not reach the register.
   *
   * Kept apart from "no matches" because the two used to render as the same
   * nothing. Field officers file households with no signal, and a panel that
   * silently shows no duplicates when it could not look is a check that
   * reports "clean" exactly when it did not run.
   */
  const [failed, setFailed] = useState(false);

  const name = useMemo(() => {
    const first = typeof firstName === 'string' ? firstName.trim() : '';
    const last = typeof lastName === 'string' ? lastName.trim() : '';
    return first.length >= 2 && last.length >= 2 ? `${first} ${last}` : '';
  }, [firstName, lastName]);

  const digits = useMemo(() => {
    const raw = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
    return raw.length >= 6 ? raw : '';
  }, [phone]);

  // A WhatsApp number of its own is a second number somebody may already answer on.
  const whatsappDigits = useMemo(() => {
    const raw = typeof whatsapp === 'string' ? whatsapp.replace(/\D/g, '') : '';
    return raw.length >= 6 && raw !== digits ? raw : '';
  }, [whatsapp, digits]);

  useEffect(() => {
    if (!token || (!name && !digits)) {
      setMatches([]);
      setFailed(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      const searches = [name, digits, whatsappDigits]
        .filter(Boolean)
        .map((search) => listCitizens(tenant, token, { search, limit: MAX_SHOWN }));

      Promise.all(searches)
        .then((results) => {
          if (cancelled) return;
          const byId = new Map<string, CitizenListItem>();
          for (const result of results) {
            for (const item of result.items) byId.set(item.id, item);
          }
          setMatches([...byId.values()].slice(0, MAX_SHOWN));
          setFailed(false);
        })
        .catch((caught) => {
          // Never a reason to stop somebody saving a household — but said, so
          // an empty panel is not read as "nobody like this is on file".
          logApiError(caught);
          if (!cancelled) {
            setMatches([]);
            setFailed(true);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tenant, token, name, digits, whatsappDigits]);

  if (failed) {
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs"
      >
        <CloudOff className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="leading-relaxed">
          <span className="font-semibold">
            {en ? 'Could not check for an existing record.' : 'تعذّر التحقق من وجود ملف سابق.'}
          </span>{' '}
          <span className="text-muted-foreground">
            {en
              ? 'The register could not be reached. If this person may already be on file, search for them once you have a connection before saving a new record.'
              : 'لم يُتح الوصول إلى السجل. إن كان هذا الشخص قد يكون مسجَّلاً فابحث عنه عند توفّر الاتصال قبل حفظ ملف جديد.'}
          </span>
        </p>
      </div>
    );
  }

  if (matches.length === 0) return null;

  const fileHref = (id: string) =>
    pathname.replace(/\/citizens\/new(\/.*)?$/, `/citizens/${encodeURIComponent(id)}`);

  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs"
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <UsersRound className="size-3.5 shrink-0" aria-hidden />
        {en ? 'Possibly already registered' : 'قد يكون مسجَّلاً مسبقاً'}
      </p>
      <p className="leading-relaxed text-muted-foreground">
        {en
          ? 'Same name or phone. If it is the same person, add the property to their file instead of creating a new one. A shared phone or a common name is not proof — open the file and check.'
          : 'الاسم أو الهاتف نفسه. إن كان الشخص نفسه فأضف العقار إلى ملفه بدل إنشاء ملف جديد. الهاتف المشترك أو الاسم المتكرر ليس دليلاً — افتح الملف وتحقَّق.'}
      </p>
      <ul className="space-y-1">
        {matches.map((match) => (
          <li key={match.id}>
            <Link
              href={fileHref(match.id)}
              target="_blank"
              rel="noopener"
              className="flex flex-wrap items-center gap-2 rounded-md bg-background/70 px-2.5 py-1.5 hover:bg-background"
            >
              <span className="font-medium">{match.fullName}</span>
              {match.motherName ? (
                <span className="text-muted-foreground">
                  {en ? `mother: ${match.motherName}` : `والدته: ${match.motherName}`}
                </span>
              ) : null}
              {match.phone ? (
                <span dir="ltr" className="text-muted-foreground">
                  {match.phone}
                </span>
              ) : null}
              {match.residence === 'NON_RESIDENT_OWNER' ? (
                <Badge variant="soft-info">{labels.citizenResidence.NON_RESIDENT_OWNER}</Badge>
              ) : null}
              <span className="text-muted-foreground">
                {en
                  ? `${match.propertyCount} propert${match.propertyCount === 1 ? 'y' : 'ies'}`
                  : `${match.propertyCount} عقار`}
              </span>
              <ExternalLink className="ms-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
