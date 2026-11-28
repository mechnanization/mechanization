import { Injectable } from '@nestjs/common';
import { internationalPhone, isNonPersonRecord } from '@mechanization/shared-schemas';
import type { AdminCitizenSubmission, PossibleDuplicatesQuery } from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ConflictError } from '../../common/exceptions';
import {
  assessFindings,
  hasFindings,
  NO_FINDINGS,
  outstandingFindings,
  possibleDuplicateFlag,
  type DuplicateCandidate,
  type DuplicateReviewFindings,
} from './possible-duplicates';
import { normalizeSearchText } from '../../../domain/value-objects/search-terms';
import { APP_CONFIG } from '../../common/app.config';

/**
 * Is this person already on file? The screen a new file and an import go
 * through (`screenForDuplicates`), the review a clerk asks for
 * (`reviewDuplicates`), and the list of likely pairs (`possibleDuplicates`),
 * all read through `duplicateLookup`. Reads citizen data and logs none of it.
 * Out of `CitizensService` (audit GOD-10).
 */
@Injectable()
export class CitizenDuplicatesService {
  constructor(
    private readonly tenantContext: TenantContextService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * A clerk filing a citizen and their first registration.
   *
   * The claim lands as PENDING, exactly as a citizen-filed one did: a clerk
   * typing what someone handed over the counter has not thereby verified it,
   * and skipping the review queue would hide staff-entered claims from the
   * only screen that checks them.
   */
  /**
   * «هل هو مسجَّل مسبقاً؟» for one filing — read-only.
   *
   * The form asks this before it writes anything (it may be about to create a
   * new structure for the household), and `create` asks it again, because a
   * question the browser skipped is not a question the register may skip.
   * The candidates come from `duplicateLookup`.
   */
  async reviewDuplicates(
    payload: AdminCitizenSubmission,
    actor: { id: string },
  ): Promise<DuplicateReviewFindings> {
    // «تركة» and «جهة أو وقف» (0076) are not checked as people — see `assessFindings`.
    if (isNonPersonRecord(payload.residence)) return NO_FINDINGS;
    const personal = payload.personal as Record<string, unknown>;
    const contact = payload.contact as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

    const incoming = {
      firstName: text(personal.firstName) ?? '',
      middleName: text(personal.middleName),
      lastName: text(personal.lastName) ?? '',
      motherName: text(personal.motherName),
      phone: text(contact.phone),
      whatsapp: text(contact.whatsapp) ?? text(contact.phone),
      civilRecordNumber: text(personal.civilRecordNumber),
      residencyNumber: text(personal.residencyNumber),
      gender: text(personal.gender),
      isLebanese: typeof personal.isLebanese === 'boolean' ? personal.isLebanese : null,
      // The flats this filing's cards name: the same door, filed a second time.
      unitIds: (payload.properties as Array<{ units?: Array<{ unitId?: string | null }> }>)
        .flatMap((card) => card.units ?? [])
        .map((unit) => unit.unitId)
        .filter((unitId): unitId is string => Boolean(unitId)),
    };

    const rows = await this.duplicateLookup(incoming);
    if (!rows) return NO_FINDINGS;

    return assessFindings({
      incoming,
      rows,
      cards: payload.properties as ReadonlyArray<{
        occupancyType?: string | null;
        landlordPhone?: string | null;
        landlordName?: string | null;
      }>,
      actorId: actor.id,
      now: new Date(),
    });
  }

  /**
   * «قد يكون مسجَّلاً مسبقاً» while the form is typed — the rule the save asks
   * by, on whatever has been typed so far.
   *
   * The panel used to run the register's search box instead: the first name
   * and the family name as two words, each of which had to appear *anywhere*
   * in a row's folded text. That text holds the father's name and the
   * mother's name too, so «حسين وطفى» offered «ابراهيم حسين برو» (حسين as his
   * father, وطفى as his mother's family) — four warnings on one screen that the
   * save's own check would never have raised, and a panel officers learned to
   * read past. Now the two agree: the panel shows exactly who the save would
   * ask about, compared part by part and never across fields.
   *
   * `excludeId` drops the file being edited, which is never its own duplicate.
   */
  async possibleDuplicates(query: PossibleDuplicatesQuery): Promise<DuplicateCandidate[]> {
    const number = (value: string | undefined) => {
      const parsed = value ? internationalPhone.safeParse(value) : null;
      return parsed?.success ? parsed.data : null;
    };
    const phone = number(query.phone);
    const incoming = {
      firstName: query.firstName?.trim() ?? '',
      middleName: query.middleName?.trim() || null,
      lastName: query.lastName?.trim() ?? '',
      motherName: query.motherName?.trim() || null,
      phone,
      whatsapp: number(query.whatsapp) ?? phone,
      civilRecordNumber: query.civilRecordNumber?.trim() || null,
      residencyNumber: query.residencyNumber?.trim() || null,
      gender: query.gender ?? null,
      isLebanese: query.isLebanese ?? null,
      unitIds: query.unitIds ?? [],
    };

    const rows = await this.duplicateLookup(incoming, query.excludeId);
    if (!rows) return [];

    const { possibleDuplicates } = assessFindings({
      incoming,
      rows,
      cards: [],
      actorId: '',
      now: new Date(),
    });
    // The strongest first: a match the save will refuse on, then a match on more facts.
    return possibleDuplicates.sort(
      (a, b) => Number(b.certain) - Number(a.certain) || b.matchedOn.length - a.matchedOn.length,
    );
  }

  /**
   * The citizens worth comparing with one person, or null when there is nothing
   * to look up by.
   *
   * Blocked on what can be matched cheaply — either number, and each name part
   * as a substring of the folded search column — and compared in the
   * application, where the Arabic-aware edit distance lives. A typo in the
   * family name is still found through the first name, and the other way round.
   */
  private async duplicateLookup(
    incoming: {
      firstName: string;
      lastName: string;
      phone: string | null;
      whatsapp: string | null;
      unitIds?: readonly string[];
    },
    excludeId?: string,
  ) {
    const numbers = [...new Set([incoming.phone, incoming.whatsapp].filter((v): v is string => Boolean(v)))];
    const tokens = [
      ...new Set(
        [incoming.firstName, incoming.lastName]
          .flatMap((part) => normalizeSearchText(part).split(' '))
          .filter((token) => token.length >= 2),
      ),
    ];
    if (numbers.length === 0 && tokens.length === 0) return null;

    const rows = await this.db.user.findMany({
      where: {
        kind: 'CITIZEN',
        isActive: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        OR: [
          ...(numbers.length ? [{ phone: { in: numbers } }, { whatsapp: { in: numbers } }] : []),
          ...tokens.map((token) => ({ searchText: { contains: token } })),
          ...(incoming.unitIds?.length
            ? [{ unitOccupancies: { some: { unitId: { in: [...incoming.unitIds] }, toDate: null } } }]
            : []),
        ],
      },
      /*
        The most register rows one lookup compares. It is blocked on the phone and
        the name parts, so this is reached only by a very common first name in a
        very large municipality; comparing in the application is cheap, and this
        bounds the read.
      */
      take: APP_CONFIG.pagination.duplicateLookupRows,
      select: {
        id: true,
        firstName: true,
        middleName: true,
        lastName: true,
        motherName: true,
        phone: true,
        whatsapp: true,
        civilRecordNumber: true,
        residencyNumber: true,
        gender: true,
        isLebanese: true,
        referenceNumber: true,
        residence: true,
        unitOccupancies: { where: { toDate: null }, select: { unitId: true } },
        registrations: {
          orderBy: { submittedAt: 'desc' },
          select: {
            submittedAt: true,
            createdById: true,
            createdBy: { select: { firstName: true, lastName: true } },
            _count: { select: { properties: { where: { endedAt: null } } } },
          },
        },
      },
    });
    return rows.map(({ unitOccupancies, ...row }) => ({
      ...row,
      unitIds: unitOccupancies.map((spell) => spell.unitId),
    }));
  }

  /**
   * The duplicate verdict on a new filing, before anything is written: refused
   * when it is certainly somebody on file (`CITIZEN_DUPLICATE_BLOCKED`), asked
   * when a person is at the screen, and otherwise filed with «سجل مشابه موجود»
   * (`serverFlags`). `create` asks it, and so does an import's dry run, with
   * the payload the import would file, so the preview refuses what the
   * import would.
   */
  async screenForDuplicates(
    input: { payload: AdminCitizenSubmission; actor: { id: string; role: string } },
    /** A re-delivery of a filing already on file: it is its own "match". */
    replay = false,
  ) {
    const findings = replay ? NO_FINDINGS : await this.reviewDuplicates(input.payload, input.actor);
    const open = outstandingFindings(findings, input.payload.duplicateReview);

    /*
      Somebody already on file beyond reasonable doubt — refused, not asked.

      For every path: the form, the offline queue (the delivery parks on the
      phone as «مرفوض» with this sentence, and nothing is lost) and the
      spreadsheet import (the row fails with it). A question the officer can
      answer «شخص آخر» to is what let the same household be filed twice; here
      the answer is the file on record, and the message names it.

      An administrator may still file past it by naming each blocking record as
      a different person, with the reason `duplicateReview` already requires.
    */
    const blocking = findings.possibleDuplicates.filter((candidate) => candidate.certain);
    const overridden =
      input.actor.role === 'SUPER_ADMIN' &&
      blocking.every((candidate) => input.payload.duplicateReview?.differentFrom.includes(candidate.id));
    if (blocking.length > 0 && !overridden) {
      const named = blocking
        .slice(0, 3)
        .map((candidate) =>
          candidate.referenceNumber ? `${candidate.fullName} (${candidate.referenceNumber})` : candidate.fullName,
        )
        .join('، ');
      throw new ConflictError({
        code: 'CITIZEN_DUPLICATE_BLOCKED',
        message: 'This person is already registered: <name>. A second file is not created. Open their file and add the property there. If it really is someone else, a system administrator decides.',
        params: { name: named },
        details: { code: 'DUPLICATE_BLOCKED', duplicateReview: { ...open, possibleDuplicates: findings.possibleDuplicates } },
      });
    }

    if (input.payload.reviewDuplicates && hasFindings(open)) {
      throw open.possibleDuplicates.length > 0
        ? new ConflictError({
            code: 'CITIZEN_POSSIBLE_DUPLICATE',
            message: 'This citizen may already be registered. Review the similar files before creating a new one.',
            details: { duplicateReview: open },
          })
        : new ConflictError({
            code: 'PHONE_BELONGS_TO_OTHER',
            message: 'This phone number is registered to someone else. Check whose number it is before saving.',
            details: { duplicateReview: open },
          });
    }

    const serverFlags =
      !input.payload.reviewDuplicates && open.possibleDuplicates.length > 0
        ? [possibleDuplicateFlag(open.possibleDuplicates)]
        : [];

    return { findings, open, serverFlags };
  }
}
