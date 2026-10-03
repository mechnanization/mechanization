'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiRequestError,
  getCase,
  logApiError,
  recordOccupancy,
  updateCase,
  type CaseSummary,
  type CaseUnitOccupant,
} from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import {
  caseLinkUnit,
  type CaseLinkPerson,
  type CaseLinkSubmission,
} from '@/components/admin/link-case-citizen-dialog';

/**
 * «ربط بمواطن» and «إلغاء الربط» on the cases list: which case the dialog is
 * open on, what it has recorded so far, and the two writes. The dialogs that
 * show this state are `CaseLinkDialog` and `CaseUnlinkDialog`.
 *
 * `load` re-reads the case list; it is the page's, so the list and this flow
 * share one query key.
 */
export function useCaseLinking({
  tenant,
  token,
  locale,
  load,
}: {
  tenant: string;
  token: string | null;
  locale: string;
  load: () => Promise<void>;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [linking, setLinking] = useState<CaseSummary | null>(null);
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  /**
   * Who «ربط» has recorded on the unit while this dialog has been open. A link
   * that stops part way leaves them recorded; the dialog is told, so pressing
   * «ربط» again links them and records only the rest — never them a second time.
   */
  const [linkRecorded, setLinkRecorded] = useState<CaseUnitOccupant[]>([]);
  /** Whether a recording in this dialog has already closed the case being linked — see `linkCitizen`. */
  const linkCaseClosedRef = useRef(false);
  /** One link or unlink at a time, whatever the button's disabled state has caught up with (STA-4). */
  const linkInFlight = useRef(false);
  /** The case whose «إلغاء الربط» is waiting for its confirmation. */
  const [pendingUnlink, setPendingUnlink] = useState<CaseSummary | null>(null);

  /**
   * After «ربط» recorded people on a unit: the case list, and every cached read
   * that recording changes — the recorded people's files and property cards
   * (`claimOnFile`), the landlord-link queue (a tenant linked to an owner), the
   * citizen lists and the buildings register. Only the case list is on screen
   * here; the rest are marked stale so the next screen reads them fresh.
   */
  const reloadAfterRecording = useCallback(
    () =>
      Promise.all([
        load(),
        queryClient.invalidateQueries({ queryKey: ['citizen-profile', tenant] }),
        queryClient.invalidateQueries({ queryKey: ['citizen-property-buildings', tenant] }),
        queryClient.invalidateQueries({ queryKey: ['citizens'] }),
        queryClient.invalidateQueries({ queryKey: ['landlord-links'] }),
        queryClient.invalidateQueries({ queryKey: ['landlord-links-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['landlord-link', tenant] }),
        queryClient.invalidateQueries({ queryKey: ['buildings', tenant] }),
      ]),
    [load, queryClient, tenant],
  );

  /** Opens «ربط بمواطن» on a case, with nothing carried over from the last one. */
  const openLink = useCallback((item: CaseSummary | null) => {
    setLinkError(null);
    setLinkRecorded([]);
    linkCaseClosedRef.current = false;
    setLinking(item);
  }, []);

  /*
    «ربط»: whoever is not on the case's unit yet is recorded on it in the
    capacity chosen — owners first, so a tenant can be linked to an owner
    recorded in the same step (the server refuses an owner recorded after
    the tenant) — and then the case is resolved by the one marked as its own.

    Each occupancy is its own request, and the server does more with each than
    record it: `recordOccupancy` closes every open case on that unit — this one
    included — naming the person just recorded (`CasesService.resolveForUnit`).
    So a link refused part way has not simply failed. The people before the
    refusal are recorded and on the bill, and the case is usually resolved by
    the first of them already. The error says exactly that, from a fresh read
    of the case; the list is re-read; and the dialog is told who was recorded,
    so a second «ربط» links them instead of recording them again.
  */
  const linkCitizen = useCallback(
    async (submission: CaseLinkSubmission) => {
      if (!token || !linking || linkInFlight.current) return;
      linkInFlight.current = true;
      const en = locale === 'en';
      const list = (names: string[]) => names.join(en ? ', ' : '، ');
      setLinkSubmitting(true);
      setLinkError(null);

      const unit = caseLinkUnit(linking, locale);
      const toRecord = unit
        ? [
            ...submission.people.filter((person) => !person.onUnit && person.role === 'OWNER'),
            ...submission.people.filter((person) => !person.onUnit && person.role !== 'OWNER'),
          ]
        : [];
      const primaryName =
        submission.people.find((person) => person.citizenId === submission.primaryId)?.name ?? '';
      const recorded: CaseUnitOccupant[] = [];
      /*
        `casesResolved` counts every case on the unit a recording closed. While
        this case is still open, the first recording counts it too — and that
        one is the case being linked, not "another case closed", so it is taken
        off once per dialog (the ref survives a retry after a partial failure).
      */
      const thisCaseCounts = linking.status !== 'RESOLVED' && linking.caseType !== 'STATUS_CONFLICT';
      let otherCasesClosed = 0;
      let current: CaseLinkPerson | null = null;
      try {
        for (const person of toRecord) {
          current = person;
          const result = await recordOccupancy(tenant, token, {
            unitId: unit!.unitId,
            citizenId: person.citizenId,
            role: person.role,
            ...(person.role === 'OWNER' && submission.ownerUnitStatus
              ? { unitStatus: submission.ownerUnitStatus }
              : {}),
            ...(person.role !== 'OWNER' && person.landlordCitizenId
              ? { landlordCitizenId: person.landlordCitizenId }
              : {}),
          });
          recorded.push({ citizenId: person.citizenId, name: person.name, role: person.role });
          let closed = result.casesResolved;
          if (closed > 0 && thisCaseCounts && !linkCaseClosedRef.current) {
            linkCaseClosedRef.current = true;
            closed -= 1;
          }
          otherCasesClosed += closed;
        }
        current = null;
        await updateCase(tenant, token, linking.id, { resolvedCitizenId: submission.primaryId });
        await (recorded.length > 0 ? reloadAfterRecording() : load());
        toast.success(en ? 'Case linked and resolved' : 'تم ربط الحالة ووضعها محلولة', {
          description: [
            primaryName,
            recorded.length > 0
              ? en
                ? `recorded on the unit: ${list(recorded.map((person) => person.name))}`
                : `سُجِّل على الوحدة: ${list(recorded.map((person) => person.name))}`
              : null,
            otherCasesClosed > 0
              ? en
                ? `${otherCasesClosed} other open case(s) on this unit were closed too`
                : `وأُغلقت ${otherCasesClosed} حالة مفتوحة أخرى على هذه الوحدة`
              : null,
          ]
            .filter(Boolean)
            .join(' — '),
        });
        openLink(null);
      } catch (caught) {
        logApiError(caught);
        const reason =
          caught instanceof ApiRequestError ? caught.message : en ? 'The request failed.' : 'تعذّر الطلب.';
        const failed: CaseLinkPerson | null = current;
        const notTried = failed
          ? toRecord.slice(toRecord.indexOf(failed) + 1).map((person) => person.name)
          : [];
        const everRecorded = recorded.length > 0 || linkRecorded.length > 0;

        // The case as the server now holds it — not as this request hoped to leave it.
        let fresh: CaseSummary | null = null;
        try {
          fresh = await getCase(tenant, token, linking.id);
        } catch (reread) {
          logApiError(reread);
        }

        setLinkError(
          [
            recorded.length > 0
              ? en
                ? `Recorded on the unit: ${list(recorded.map((person) => person.name))}.`
                : `سُجِّل على الوحدة: ${list(recorded.map((person) => person.name))}.`
              : null,
            failed
              ? en
                ? `Not recorded: ${failed.name} — ${reason}`
                : `لم يُسجَّل ${failed.name}: ${reason}`
              : en
                ? `Could not link the case to ${primaryName}: ${reason}`
                : `تعذّر ربط الحالة بـ${primaryName}: ${reason}`,
            notTried.length > 0
              ? en
                ? `Not attempted: ${list(notTried)}.`
                : `لم يُحاوَل تسجيل: ${list(notTried)}.`
              : null,
            otherCasesClosed > 0
              ? en
                ? `${otherCasesClosed} other open case(s) on this unit were closed.`
                : `أُغلقت ${otherCasesClosed} حالة مفتوحة أخرى على هذه الوحدة.`
              : null,
            fresh?.resolvedCitizenId
              ? en
                ? `The case is now resolved and linked to ${fresh.resolvedCitizenName ?? '—'}: recording someone on its unit closes the unit's open cases.`
                : `الحالة الآن محلولة ومرتبطة بـ${fresh.resolvedCitizenName ?? '—'}: تسجيل شخص على وحدتها يُغلق حالاتها المفتوحة.`
              : fresh || !everRecorded
                ? en
                  ? 'The case is not linked.'
                  : 'لم تُربط الحالة.'
                : en
                  ? 'The case could not be re-read — the list shows whether it is linked.'
                  : 'تعذّرت إعادة قراءة الحالة — القائمة تُظهر هل رُبطت.',
            everRecorded
              ? en
                ? 'Whoever was recorded stays on the unit; pressing "Link" again links them without recording them twice.'
                : 'من سُجِّل يبقى على الوحدة؛ الضغط على «ربط» من جديد يربطهم دون تسجيلهم مرة ثانية.'
              : null,
          ]
            .filter(Boolean)
            .join(' '),
        );
        if (recorded.length > 0) {
          setLinkRecorded((previous) => [...previous, ...recorded]);
          /*
            Awaited, so «ربط» stays busy until the list holds them too: closed
            and reopened from a list not yet re-read, the case would offer them
            as not on the unit and record them a second time.
          */
          await reloadAfterRecording().catch(logApiError);
        }
      } finally {
        linkInFlight.current = false;
        setLinkSubmitting(false);
      }
    },
    [tenant, token, linking, linkRecorded, load, reloadAfterRecording, openLink, toast, locale],
  );

  /**
   * «إلغاء الربط», once confirmed. It clears the case's citizen and nothing
   * else: whoever «ربط» recorded on the unit stays there and on the bill, which
   * the confirmation says before this runs. Throws so `ConfirmDialog` shows a
   * refusal in place (PRIM-16).
   */
  const unlinkCitizen = useCallback(
    async (item: CaseSummary) => {
      const en = locale === 'en';
      if (!token) throw new Error(en ? 'Your session has ended.' : 'انتهت الجلسة.');
      if (linkInFlight.current) {
        throw new Error(
          en ? 'Another change to this case is still being saved.' : 'ما زال تعديل آخر على الحالة قيد الحفظ.',
        );
      }
      linkInFlight.current = true;
      try {
        await updateCase(tenant, token, item.id, { resolvedCitizenId: null });
        await load();
        toast.success(en ? 'Link removed' : 'أُزيل الربط', {
          description: caseLinkUnit(item, locale)
            ? en
              ? 'Nobody was taken off the unit.'
              : 'لم يُخرَج أحد من الوحدة.'
            : undefined,
        });
      } catch (caught) {
        logApiError(caught);
        throw new Error(
          caught instanceof ApiRequestError
            ? caught.message
            : en
              ? 'Could not remove the link.'
              : 'تعذّر إلغاء الربط.',
        );
      } finally {
        linkInFlight.current = false;
      }
    },
    [tenant, token, load, toast, locale],
  );

  /** Who the census records on the case being linked, plus whoever this dialog has recorded since it opened. */
  const linkSuggested = useMemo(() => {
    const byId = new Map<string, CaseUnitOccupant>();
    for (const row of linking?.unitOccupants ?? []) byId.set(row.citizenId, row);
    for (const row of linkRecorded) byId.set(row.citizenId, row);
    return [...byId.values()];
  }, [linking, linkRecorded]);

  return {
    linking,
    linkSubmitting,
    linkError,
    linkSuggested,
    openLink,
    linkCitizen,
    pendingUnlink,
    setPendingUnlink,
    unlinkCitizen,
  };
}

/** What `useCaseLinking` hands the page and the two dialogs. */
export type CaseLinking = ReturnType<typeof useCaseLinking>;
