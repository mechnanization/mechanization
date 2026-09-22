'use client';

import { CloudOff, Loader2, Pencil, RefreshCw, TriangleAlert, Trash2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useState } from 'react';
import { useOfflineQueue } from '@/lib/offline-sync';
import { ShellLink } from './shell-nav';
import { cn } from '@/lib/utils';

/**
 * The offline queue, made visible.
 *
 * A queue nobody can see is a queue nobody trusts. An officer who filed twelve
 * households in a settlement needs to be able to check, from the truck, that
 * twelve are still waiting and that none of them failed — otherwise the only
 * honest thing they can do is re-enter everything, which is worse than not
 * having offline entry at all.
 */

/** A one-line summary with a manual «مزامنة», for the entry form's header. */
export function OfflineQueueNotice({
  pending,
  blocked,
  syncing,
  authRequired,
  onSync,
  href,
  locale = 'ar',
}: {
  pending: number;
  blocked: number;
  syncing: boolean;
  /** Records are waiting and there is no session to send them under. */
  authRequired: boolean;
  onSync: () => void;
  /** Where the full queue is listed. */
  href: string;
  locale?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border p-2.5 text-xs',
        blocked > 0
          ? 'border-destructive/40 bg-destructive/5'
          : 'border-warning/40 bg-warning/5',
      )}
    >
      {blocked > 0 ? (
        <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      ) : (
        <CloudOff className="size-4 shrink-0 text-warning" aria-hidden />
      )}

      <p className="min-w-0 flex-1">
        {pending > 0
          ? locale === 'en'
            ? `${pending} record(s) saved on this device, waiting to sync.`
            : `${pending} سجل محفوظ على هذا الجهاز بانتظار الإرسال.`
          : null}
        {blocked > 0 ? (
          <span className="block font-medium text-destructive">
            {locale === 'en'
              ? `${blocked} record(s) were refused by the server and need attention.`
              : `${blocked} سجل رفضه الخادم ويحتاج إلى مراجعة.`}
          </span>
        ) : null}
        {/*
          Said here as well as in the panel, because this is the banner on the
          entry form — where an officer is most likely to file another record
          and walk away believing the previous ones went out.
        */}
        {authRequired ? (
          <span className="block font-medium text-destructive">
            {locale === 'en'
              ? 'Your session has ended — sign in again to send these records.'
              : 'انتهت الجلسة — يرجى تسجيل الدخول مجدداً لإرسال هذه السجلات.'}
          </span>
        ) : null}
      </p>

      <ShellLink
        href={href}
        className="shrink-0 font-medium text-primary underline-offset-4 hover:underline"
      >
        {locale === 'en' ? 'View queue' : 'عرض القائمة'}
      </ShellLink>

      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onSync}
        disabled={syncing || pending === 0 || authRequired}
        className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
      >
        {syncing ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <RefreshCw className="size-3.5" aria-hidden />
        )}
        {locale === 'en' ? 'Sync now' : 'مزامنة الآن'}
      </Button>
    </div>
  );
}

/**
 * The queue in full: every record still on this device, and what happened to it.
 *
 * Shown above the registry table rather than on a page of its own. These
 * records *are* part of the registry as far as the officer is concerned — they
 * are people who have been registered — and putting them anywhere else invites
 * the reading that the table below is complete when it is not.
 */
export function OfflineQueuePanel({
  tenant,
  base,
  locale = 'ar',
}: {
  tenant: string;
  /** `/{tenant}/{locale}/{adminPath}` — where the «تعديل» link leads. */
  base: string;
  locale?: string;
}) {
  const queue = useOfflineQueue(tenant);
  const [discarding, setDiscarding] = useState<string | null>(null);

  if (queue.items.length === 0) return null;

  const discardTarget = queue.items.find((item) => item.id === discarding);

  return (
    <section
      className={cn(
        'space-y-2.5 rounded-xl border p-3',
        queue.blocked > 0
          ? 'border-destructive/40 bg-destructive/5'
          : 'border-warning/40 bg-warning/5',
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <CloudOff className="size-4 shrink-0 text-warning" aria-hidden />
          {locale === 'en'
            ? `Saved on this device (${queue.items.length})`
            : `محفوظ على هذا الجهاز (${queue.items.length})`}
        </h2>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {queue.online
              ? locale === 'en'
                ? 'Connected'
                : 'متصل'
              : locale === 'en'
                ? 'No connection'
                : 'لا يوجد اتصال'}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={queue.sync}
            disabled={queue.syncing || queue.pending === 0 || queue.authRequired}
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            {queue.syncing ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-3.5" aria-hidden />
            )}
            {locale === 'en' ? 'Sync now' : 'مزامنة الآن'}
          </Button>
        </div>
      </header>

      {queue.authRequired ? (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs font-medium text-destructive"
        >
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {locale === 'en'
            ? 'Your session has ended. These records are safe on this device and will be sent once you sign in again.'
            : 'انتهت الجلسة. السجلات محفوظة على هذا الجهاز وستُرسل بعد تسجيل الدخول مجدداً.'}
        </p>
      ) : null}

      <ul className="space-y-1.5">
        {queue.items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background p-2 text-xs"
          >
            <span className="min-w-0 flex-1 truncate font-medium">{item.displayName}</span>

            {item.payload.flags.length > 0 ? (
              <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">
                {locale === 'en'
                  ? `${item.payload.flags.length} unverified`
                  : `${item.payload.flags.length} غير مؤكَّد`}
              </span>
            ) : null}

            {/*
              `basis-full` rather than `shrink-0`: a rejection is a whole
              sentence from the server («رقم العقار غير موجود…»), and holding it
              on one line pushed «تعديل» and «حذف» off the side of a phone —
              the two things the message exists to prompt.
            */}
            {item.status === 'blocked' ? (
              <span className="min-w-0 basis-full text-destructive sm:basis-auto sm:flex-1">
                {/* Verbatim, because it is the only thing that says what to fix. */}
                {item.lastError}
              </span>
            ) : item.lastError ? (
              <span className="flex min-w-0 basis-full items-center gap-1 font-medium text-warning sm:basis-auto sm:flex-1">
                <TriangleAlert className="size-3 shrink-0" aria-hidden />
                {item.lastError}
              </span>
            ) : (
              <span className="shrink-0 text-muted-foreground">
                {locale === 'en' ? 'Waiting to sync' : 'بانتظار الإرسال'}
              </span>
            )}

            {/*
              Shown on every record, not only a blocked one.

              «إعادة المحاولة» resends the exact payload the server already
              refused — correct when the *world* changed underneath it (a
              duplicate identity document was deleted elsewhere), useless when
              the record itself is what needs to change, which is the more
              common shape of a rejection: a mistyped رقم العقار, a property
              type this tenant does not enable. «تعديل» is what actually fixes
              that. It is offered for a still-pending record too — an officer
              who spots their own mistake before it was ever attempted should
              not have to wait for a rejection to be allowed to correct it.
            */}
            <ShellLink
              href={`${base}/citizens/queue/${item.id}`}
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'h-7 shrink-0 gap-1 px-2 text-xs',
              )}
            >
              <Pencil className="size-3.5" aria-hidden />
              {locale === 'en' ? 'Edit' : 'تعديل'}
            </ShellLink>

            {item.status === 'blocked' ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => queue.retry(item.id)}
                  className="h-7 shrink-0 px-2 text-xs"
                >
                  {locale === 'en' ? 'Retry' : 'إعادة المحاولة'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setDiscarding(item.id)}
                  className="h-7 shrink-0 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                  {locale === 'en' ? 'Discard' : 'حذف'}
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      {/*
        Discarding is the one irreversible thing this panel can do — the record
        exists nowhere else — so it is the one thing behind a confirmation, and
        the copy says what is actually lost rather than "are you sure".
      */}
      <ConfirmDialog
        open={discarding !== null}
        onOpenChange={(open) => setDiscarding(open ? discarding : null)}
        title={locale === 'en' ? 'Discard this record?' : 'حذف هذا السجل؟'}
        description={
          locale === 'en' ? (
            <>
              <strong>{discardTarget?.displayName}</strong> was never sent to the municipality and
              is stored only on this device. Discarding it deletes the registration entirely — the
              household would have to be entered again from the beginning.
            </>
          ) : (
            <>
              <strong>{discardTarget?.displayName}</strong> لم يصل إلى البلدية وهو محفوظ على هذا
              الجهاز فقط. حذفه يعني إلغاء التسجيل نهائياً — وسيلزم إدخال بيانات الأسرة من جديد.
            </>
          )
        }
        confirmLabel={locale === 'en' ? 'Discard record' : 'حذف السجل'}
        onConfirm={() => {
          if (discarding) queue.discard(discarding);
          setDiscarding(null);
        }}
      />
    </section>
  );
}
