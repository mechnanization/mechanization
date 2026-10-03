'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, FileText, Loader2 } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getDocumentViewUrl,
  logApiError,
  type CitizenProfileDocument,
} from '@/lib/api-client';
import { clearSession } from '@/lib/session';
import { useToast } from '@/components/ui/toast';

/**
 * A registration's attachments — «سند الملكية», «وثيقة الإثبات» — each opened in
 * a new tab through the signed-URL route, which records who viewed what.
 * Storage paths never reach the browser.
 *
 * Shared by the citizen's file and «فحص الملف», so a document opens the same
 * way, with the same expired-session and expired-link handling, wherever it is
 * listed.
 */
export function DocumentList({
  documents,
  tenant,
  base,
  token,
  locale = 'ar',
  emptyLabel,
}: {
  documents: CitizenProfileDocument[];
  tenant: string;
  /** The admin path prefix, for the sign-in redirect on an expired session. */
  base: string;
  token: string | null;
  locale?: string;
  /** Said when there is nothing to list; nothing is rendered when omitted. */
  emptyLabel?: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const router = useRouter();
  const toast = useToast();
  const [openingId, setOpeningId] = useState<string | null>(null);

  const open = async (documentId: string) => {
    if (!token) return;
    setOpeningId(documentId);
    try {
      const { url } = await getDocumentViewUrl(tenant, token, documentId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`${base}/login`);
        return;
      }
      toast.error(en ? 'Failed to open file' : 'تعذّر فتح الملف', {
        description:
          caught instanceof ApiRequestError
            ? caught.message
            : en
              ? 'Link may have expired.'
              : 'قد يكون الرابط منتهي الصلاحية.',
      });
    } finally {
      setOpeningId(null);
    }
  };

  if (documents.length === 0) {
    return emptyLabel ? <p className="text-sm text-muted-foreground">{emptyLabel}</p> : null;
  }

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {documents.map((document) => {
        const name = labels.documentType?.[document.type as never] ?? document.type;
        return (
          <li key={document.id}>
            <button
              type="button"
              onClick={() => void open(document.id)}
              disabled={openingId === document.id}
              aria-label={en ? `Open ${name} in a new tab` : `فتح ${name} في نافذة جديدة`}
              className="flex w-full items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3 text-start transition-colors hover:bg-muted/60 disabled:opacity-60"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm font-medium">{name}</span>
              </span>
              {openingId === document.id ? (
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
              ) : (
                <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
