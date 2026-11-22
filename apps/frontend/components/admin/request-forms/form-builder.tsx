'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, CirclePause, CirclePlay, Rocket, Save, Trash2 } from 'lucide-react';
import { REQUEST_FIELD_TYPE, REQUEST_FORM_MAX_FIELDS, getLabels, type RequestFieldType } from '@mechanization/shared-schemas';
import { ApiRequestError, logApiError } from '@/lib/api-client';
import {
  archiveRequestForm,
  deleteRequestForm,
  publishRequestForm,
  saveRequestFormDraft,
  setRequestFormEnabled,
  startRequestFormDraft,
  type RequestFormView,
} from '@/lib/request-forms-api';
import {
  asksForIdentityCopy,
  draftProblems,
  fromView,
  isDirty,
  moveField,
  newField,
  removeField,
  replaceField,
  toSaveFields,
  type FieldDraft,
} from '@/lib/request-form-draft';
import { useLeaveGuard } from '@/lib/use-leave-guard';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { FieldEditor } from './field-editor';

type Dialog = 'publish' | 'archive' | 'delete' | null;

/**
 * The questions of one form and the actions on it (docs/request-forms-plan.md §6).
 *
 * A form is edited as a draft: the questions are saved whole under the revision the editor read, so two managers never
 * overwrite each other (`REQUEST_FORM_EDIT_CONFLICT`), and the draft is published once and then frozen (F2). A published form
 * with no draft is shown as it stands, with «تعديل النموذج» to start one from a copy. Every question is required (F4), so no
 * question has a switch for that; the server judges every rule again.
 *
 * Remounted by its parent whenever the server's form changes (`key`), so the local questions always start from what the
 * server holds after a save, a publish or a reload.
 */
export function FormBuilder({
  tenant,
  token,
  locale,
  base,
  form,
  canManage,
  onForm,
  onReload,
}: {
  tenant: string;
  token: string;
  locale: string;
  base: string;
  form: RequestFormView;
  canManage: boolean;
  onForm: (form: RequestFormView) => void;
  onReload: () => void;
}): React.JSX.Element {
  const t = useTranslations('requests.forms.builder');
  const states = useTranslations('requests.forms.list.status');
  const labels = getLabels(locale);
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  const archived = form.archivedAt !== null;
  const draft = form.draft;
  const editable = canManage && !archived && draft !== null;
  const shown = draft ?? form.current;

  const saved = useMemo(() => (shown?.fields ?? []).map(fromView), [shown]);
  const [fields, setFields] = useState<FieldDraft[]>(saved);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; conflict: boolean } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const inFlight = useRef(false);

  const dirty = editable && isDirty(saved, fields);
  const problems = useMemo(() => draftProblems(fields), [fields]);
  const leave = useLeaveGuard(dirty);

  const run = async (name: string, work: () => Promise<void>, fallback: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(name);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      logApiError(caught);
      setMessage({
        text: caught instanceof Error && caught.message ? caught.message : fallback,
        conflict: caught instanceof ApiRequestError && caught.code === 'REQUEST_FORM_EDIT_CONFLICT',
      });
      throw caught;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  /** Anything the server answered with: the form, kept in the cache the list reads too. */
  const accept = (next: RequestFormView) => {
    onForm(next);
    void queryClient.invalidateQueries({ queryKey: ['request-forms', tenant, 'list'] });
  };

  const saveDraft = () => {
    if (!draft) return;
    const definitions = toSaveFields(fields);
    if (!definitions) {
      setMessage({ text: t('actions.fixFirst'), conflict: false });
      return;
    }
    void run(
      'save',
      async () => {
        accept(await saveRequestFormDraft(tenant, token, form.id, { expectedRevision: draft.revision, fields: definitions }));
        toast.success(t('actions.saved'));
      },
      t('actions.saveError'),
    ).catch(() => undefined);
  };

  const startDraft = () =>
    void run('start', async () => accept(await startRequestFormDraft(tenant, token, form.id)), t('questions.editError')).catch(() => undefined);

  const toggle = () =>
    void run(
      'toggle',
      async () => {
        accept(await setRequestFormEnabled(tenant, token, form.id, !form.enabled));
        toast.success(form.enabled ? t('actions.disabled') : t('actions.enabled'));
      },
      t('actions.toggleError'),
    ).catch(() => undefined);

  const add = (type: RequestFieldType) => {
    if (fields.length >= REQUEST_FORM_MAX_FIELDS) return;
    setFields((current) => [...current, newField(type, current.map((field) => field.key))]);
  };

  // A dialog's `onConfirm` throws to stay open: the failure is shown in the dialog itself.
  const confirmPublish = () =>
    run(
      'publish',
      async () => {
        const next = await publishRequestForm(tenant, token, form.id);
        accept(next);
        setDialog(null);
        toast.success(t('actions.published', { number: next.current?.versionNumber ?? 0 }));
      },
      t('actions.publishError'),
    );
  const confirmArchive = () =>
    run(
      'archive',
      async () => {
        accept(await archiveRequestForm(tenant, token, form.id));
        setDialog(null);
        toast.success(t('actions.archived'));
      },
      t('actions.archiveError'),
    );
  const confirmDelete = () =>
    run(
      'delete',
      async () => {
        await deleteRequestForm(tenant, token, form.id);
        void queryClient.invalidateQueries({ queryKey: ['request-forms', tenant] });
        toast.success(t('actions.deleted'));
        router.push(`${base}/requests/forms`);
      },
      t('actions.deleteError'),
    );

  const deleteBlocked = form.systemType !== null ? t('actions.deleteSystem') : form.requestCount > 0 ? t('actions.deleteHasRequests') : null;
  const everyTypeNamed = fields.length > 0 && problems.size === 0;
  const canPublish = editable && !dirty && everyTypeNamed && busy === null;

  return (
    <div className="space-y-6">
      {archived ? <Alert variant="info" title={t('archivedNotice')} /> : null}
      {!canManage && !archived ? <Alert variant="info" title={t('readOnlyNotice')} /> : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-2">
          <CardTitle className="text-base">
            <h2>{t('questions.title')}</h2>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <CellTag tone={form.enabled ? 'success' : 'muted'}>{form.enabled ? states('live') : states('off')}</CellTag>
            <span>{draft ? t('draftLine', { number: draft.versionNumber, revision: draft.revision }) : form.current ? t('publishedLine', { number: form.current.versionNumber }) : t('neverPublished')}</span>
            <span>{t('requestCount', { count: form.requestCount })}</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">{t('questions.allRequired')}</p>

          {message ? (
            <Alert variant="destructive" live="alert" title={message.text}>
              {message.conflict ? (
                <Button type="button" variant="outline" size="sm" onClick={onReload}>
                  {t('actions.reload')}
                </Button>
              ) : null}
            </Alert>
          ) : null}

          {editable && fields.length > 0 && !asksForIdentityCopy(fields) ? <Alert variant="warning" title={t('questions.identityMissing')} /> : null}

          {fields.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{t('questions.empty')}</p>
          ) : (
            <ol className="space-y-3">
              {fields.map((field, index) => (
                <li key={field.uid}>
                  <FieldEditor
                    field={field}
                    index={index}
                    total={fields.length}
                    locale={locale}
                    problems={problems.get(field.uid) ?? []}
                    disabled={!editable || busy !== null}
                    onChange={(next) => setFields((current) => replaceField(current, next))}
                    onMove={(delta) => setFields((current) => moveField(current, index, delta))}
                    onRemove={() => setFields((current) => removeField(current, field.uid))}
                  />
                </li>
              ))}
            </ol>
          )}

          {editable ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full sm:w-72">
                <Select value="" disabled={fields.length >= REQUEST_FORM_MAX_FIELDS || busy !== null} onValueChange={(value) => add(value as RequestFieldType)}>
                  <SelectTrigger aria-label={t('questions.add')}>
                    <SelectValue placeholder={t('questions.addPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {REQUEST_FIELD_TYPE.map((type) => (
                      <SelectItem key={type} value={type}>
                        {labels.requestFieldType[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="pb-2 text-xs text-muted-foreground">
                {fields.length >= REQUEST_FORM_MAX_FIELDS ? t('questions.full') : t('questions.count', { count: fields.length, max: REQUEST_FORM_MAX_FIELDS })}
              </span>
            </div>
          ) : null}

          {canManage && !archived && !draft ? (
            <div className="space-y-2">
              <Button type="button" onClick={startDraft} disabled={busy !== null}>
                {busy === 'start' ? t('questions.editing') : t('questions.edit')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('questions.editHint')}</p>
            </div>
          ) : null}

          {editable ? (
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button type="button" onClick={saveDraft} disabled={!dirty || busy !== null}>
                <Save className="size-4" aria-hidden />
                {busy === 'save' ? t('actions.saving') : t('actions.saveDraft')}
              </Button>
              <Button type="button" variant="outline" onClick={() => setDialog('publish')} disabled={!canPublish}>
                <Rocket className="size-4" aria-hidden />
                {t('actions.publish')}
              </Button>
              {dirty ? <span className="text-sm text-muted-foreground">{t('actions.unsaved')}</span> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {canManage && !archived ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={toggle}
            disabled={busy !== null || (!form.enabled && !form.current)}
            title={!form.enabled && !form.current ? t('actions.enableNeedsPublish') : undefined}
          >
            {form.enabled ? <CirclePause className="size-4" aria-hidden /> : <CirclePlay className="size-4" aria-hidden />}
            {form.enabled ? t('actions.disable') : t('actions.enable')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setDialog('archive')} disabled={busy !== null}>
            <Archive className="size-4" aria-hidden />
            {t('actions.archive')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setDialog('delete')} disabled={busy !== null}>
            <Trash2 className="size-4" aria-hidden />
            {t('actions.delete')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={dialog === 'publish'}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        destructive={false}
        title={t('actions.publishTitle')}
        description={t('actions.publishDescription')}
        confirmLabel={t('actions.publish')}
        busyLabel={t('actions.publishing')}
        cancelLabel={t('actions.cancel')}
        onConfirm={confirmPublish}
      />
      <ConfirmDialog
        open={dialog === 'archive'}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        title={t('actions.archiveTitle')}
        description={t('actions.archiveDescription')}
        confirmLabel={t('actions.archive')}
        cancelLabel={t('actions.cancel')}
        onConfirm={confirmArchive}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        title={t('actions.deleteTitle')}
        description={deleteBlocked ?? t('actions.deleteDescription')}
        confirmLabel={t('actions.delete')}
        cancelLabel={t('actions.cancel')}
        confirmDisabled={deleteBlocked !== null}
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={leave.pendingHref !== null}
        onOpenChange={(open) => (open ? undefined : leave.stay())}
        title={t('leave.title')}
        description={t('leave.description')}
        confirmLabel={t('leave.leave')}
        cancelLabel={t('leave.stay')}
        onConfirm={leave.leave}
      />
    </div>
  );
}
