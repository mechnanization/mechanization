import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-client';
import { PropertyEntry } from '../../domain/entities/property-entry.entity';
import { Registration } from '../../domain/entities/registration.entity';
import { ConflictError } from '../../domain/errors/domain-error';
import {
  RegistrationRepository,
  SubmitRegistrationInput,
  SubmitRegistrationResult,
} from '../../domain/interfaces/registration-repository.interface';
import { TenantContextService } from '../context/tenant-context.service';
import { normalizeSearchText } from '../../application/common/search-terms';

/** Where an identity-document clash is recorded on the new citizen's file. */
const IDENTITY_DOC_PATH = 'personal.identityDocNumber';

/**
 * Whether the holder of a document number is the person now being filed.
 *
 * Names folded the way search folds them (أ/ا, ة/ه, digits, spacing), so a
 * spelling difference at a doorstep does not split one person into two. First
 * and last name must agree; اسم الأب is compared only when both sides have one,
 * because it is the field most often left empty. Anything short of that is a
 * different person as far as this path is concerned — a missed attach costs a
 * duplicate a person can merge; a wrong attach costs a person.
 */
export function isSamePerson(
  holder: { firstName: string; middleName: string | null; lastName: string },
  filed: { firstName: string; middleName?: string | null; lastName: string },
): boolean {
  const fold = (value: string | null | undefined) => normalizeSearchText(value ?? '');
  if (fold(holder.firstName) !== fold(filed.firstName)) return false;
  if (fold(holder.lastName) !== fold(filed.lastName)) return false;
  const holderMiddle = fold(holder.middleName);
  const filedMiddle = fold(filed.middleName);
  return !holderMiddle || !filedMiddle || holderMiddle === filedMiddle;
}

@Injectable()
export class PrismaRegistrationRepository implements RegistrationRepository {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * Citizen upsert + registration + every property row in one transaction.
   *
   * A partial write is worse than a clean failure here: the citizen sees an
   * error, retries the whole wizard, and collides with the property rows their
   * "failed" attempt already committed — leaving them unable to file at all.
   */
  async submit(input: SubmitRegistrationInput): Promise<SubmitRegistrationResult> {
    const tenantSlug = this.tenantContext.tenantSlug;

    /*
      A submission the queue has already delivered is answered, not repeated.

      This is checked before the transaction rather than relying on the unique
      index to reject the second write, because the caller does not want an
      error — it wants the registration this submission produced the first
      time, so the phone that never heard the original response can mark its
      queued copy done and stop asking. The index is still what makes the check
      safe against two syncs racing: the loser lands on P2002 and is translated
      into the same lookup below.
    */
    if (input.clientSubmissionId) {
      const already = await this.findByClientSubmissionId(input.clientSubmissionId);
      if (already) return already;
    }

    /*
      Which identity key this citizen can be matched on — and whether there is
      one at all.

      `users` is keyed by (نوع الوثيقة, رقم الوثيقة), which is what stops the
      same person being registered twice under two spellings of their name. A
      record whose document number was never established has no such key: it
      cannot be upserted onto, and it must not collide with every other record
      in the same position. Postgres treats NULLs in a unique index as
      distinct, so writing a genuine null — rather than the empty string this
      used to fall back to — is what keeps two unidentified citizens two rows
      instead of one conflict.
    */
    const identityDocNumber = input.citizen.identityDocNumber?.trim() || null;
    const identityDocType = identityDocNumber ? (input.citizen.identityDocType ?? null) : null;

    const shared = {
      phone: input.citizen.phone ?? null,
      whatsapp: input.citizen.whatsapp ?? input.citizen.phone ?? null,
      firstName: input.citizen.firstName,
      middleName: input.citizen.middleName ?? null,
      lastName: input.citizen.lastName,
      gender: (input.citizen.gender ?? null) as never,
      nationality: input.citizen.nationality ?? null,
      isLebanese: input.citizen.isLebanese ?? null,
      residencyNumber: input.citizen.residencyNumber ?? null,
      residentStatus: (input.citizen.residentStatus ?? null) as never,
      civilRecordNumber: input.citizen.civilRecordNumber ?? null,
      totalRegisteredMembers: input.citizen.totalRegisteredMembers ?? input.citizen.actualHouseholdMembers ?? null,
      actualHouseholdMembers: input.citizen.actualHouseholdMembers ?? null,
      maritalStatus: (input.citizen.maritalStatus ?? null) as never,
      bloodType: (input.citizen.bloodType ?? null) as never,
      residence: (input.citizen.residence ?? 'RESIDENT') as never,
      residencePlace: input.citizen.residencePlace ?? null,
      localContactName: input.citizen.localContactName ?? null,
      localContactPhone: input.citizen.localContactPhone ?? null,
    };

    try {
      return await this.db.$transaction(async (tx) => {
        /*
          A filing never overwrites a person who is already on file.

          This used to be an `upsert` on (نوع الوثيقة, رقم الوثيقة) whose update
          branch wrote the new filing's name, phone and household over the
          existing row. On the first day of field work in production officers
          had been told the document was no longer required and typed shared or
          invented numbers — so every repeated number renamed the citizen who
          used it first and hung the new registration off that row. Three
          brothers became one person carrying the last brother's name, and no
          audit row kept the other names. A merge cannot be undone; a duplicate
          can be merged later by a person with both files in front of them.

          So the number is now a *question*, asked before anything is written:

            • nobody holds it → a new citizen carries it (`NEW`);
            • a citizen with the same name holds it → this registration is added
              to their file and nothing on that file changes (`ATTACHED`);
            • somebody with a different name holds it → a new citizen is created
              *without* it, and the number goes into a «غير مؤكَّد» flag with
              the reason, so a person resolves it (`CONFLICT`).

          Only a non-Lebanese person's passport number reaches here now — the
          form no longer asks a Lebanese citizen for a document — but the rule
          is the same for any number, including those already in the register.
        */
        let identity: SubmitRegistrationResult['identity'];
        let attachedTo: string | null = null;

        if (identityDocType && identityDocNumber) {
          const holder = await tx.user.findUnique({
            where: {
              identityDocType_identityDocNumber: {
                identityDocType: identityDocType as never,
                identityDocNumber,
              },
            },
            select: { id: true, kind: true, firstName: true, middleName: true, lastName: true },
          });

          if (!holder) {
            identity = 'NEW';
          } else if (holder.kind === 'CITIZEN' && isSamePerson(holder, input.citizen)) {
            identity = 'ATTACHED';
            attachedTo = holder.id;
          } else {
            identity = 'CONFLICT';
          }
        }

        const flaggedFields =
          identity === 'CONFLICT'
            ? [
                ...input.flaggedFields.filter((flag) => flag.path !== IDENTITY_DOC_PATH),
                {
                  path: IDENTITY_DOC_PATH,
                  kind: 'UNESTABLISHED',
                  reason: `رقم الوثيقة المُدخل (${identityDocNumber}) مسجَّل لمواطن آخر باسم مختلف، فلم يُحفظ على هذا الملف — يلزم التحقق من الوثيقة`,
                },
              ]
            : input.flaggedFields;
        const status = flaggedFields.length > 0 ? 'REQUIRES_REVIEW' : input.status;

        const citizen = attachedTo
          ? { id: attachedTo }
          : await tx.user.create({
              data: {
                kind: 'CITIZEN',
                tenantSlug,
                ...shared,
                identityDocType: (identity === 'NEW' ? identityDocType : null) as never,
                identityDocNumber: identity === 'NEW' ? identityDocNumber : null,
                referenceNumber: input.citizenReference,
              },
              select: { id: true },
            });

        const registration = await tx.registration.create({
          data: {
            citizenId: citizen.id,
            referenceNumber: input.registrationReference,
            /*
              `status` is written again, for one distinction only.

              The old PENDING → VERIFIED → APPROVED workflow is gone and none of
              those labels is set by anything. What is set is REQUIRES_REVIEW,
              which is not a stage of adjudication: it says named fields on this
              record were never established. It is stored rather than derived
              from `flaggedFields` so the registry can filter on an indexed
              column instead of unpacking a json array per row.
            */
            status,
            flaggedFields: flaggedFields as never,
            blanketFlagReason: input.blanketFlagReason ?? null,
            notes: input.notes ?? null,
            createdById: input.createdById ?? null,
            clientSubmissionId: input.clientSubmissionId ?? null,
          },
          select: { id: true, referenceNumber: true },
        });

        const propertyIds: string[] = [];
        for (const property of input.properties) {
          const p = property.props;
          const created = await tx.propertyEntry.create({
            data: {
              registrationId: registration.id,
              occupancyType: p.occupancyType as never,
              landlordName: p.landlordName ?? null,
              landlordPhone: p.landlordPhone ?? null,
              propertyType: p.propertyType as never,
              neighborhood: p.neighborhood,
              propertyNumber: p.propertyNumber,
              unitType: (p.unitType ?? null) as never,
              landType: (p.landType ?? null) as never,
              buildingName: p.buildingName ?? null,
              floor: p.floor ?? null,
              side: p.side ?? null,
              tentLocation: p.tentLocation ?? null,
              unitArea: p.unitArea ?? null,
              shares: p.shares ?? null,
              sharedRights: p.sharedRights ?? [],
              unitStatus: (p.unitStatus ?? null) as never,
              latitude: p.latitude ?? null,
              longitude: p.longitude ?? null,
              // The census link, where the officer picked a structure. Nullable
              // through and through — see §3.7 and P2-T8's authority rule.
              buildingId: p.buildingId ?? null,
              // A building carries its units here rather than in the columns
              // above — one parcel, one رقم العقار, many apartments.
              units: {
                create: (p.units ?? []).map((unit) => ({
                  unitType: unit.unitType as never,
                  floor: unit.floor,
                  side: unit.side ?? null,
                  unitArea: unit.unitArea,
                  sharedRights: unit.sharedRights ?? [],
                  unitStatus: (unit.unitStatus ?? null) as never,
                  unitId: unit.unitId ?? null,
                })),
              },
            },
            select: { id: true },
          });
          propertyIds.push(created.id);
        }

        return {
          registrationId: registration.id,
          citizenId: citizen.id,
          referenceNumber: registration.referenceNumber,
          propertyIds,
          deduplicated: false,
          identity,
        };
      });
    } catch (error) {
      /*
        Two syncs of the same queued record, racing.

        Both passed the pre-flight lookup because neither had committed when the
        other read; the unique index then refuses the second. That is the index
        doing its job, and the caller still wants an answer rather than an
        error, so the committed row is fetched and returned as though the loser
        had found it in the first place.
      */
      if (input.clientSubmissionId && this.isSubmissionIdConflict(error)) {
        const already = await this.findByClientSubmissionId(input.clientSubmissionId);
        if (already) return already;
      }
      throw this.translate(error);
    }
  }

  /**
   * The registration a given offline submission already produced, if any.
   *
   * Returns the same shape `submit` does so the caller cannot tell a
   * deduplicated answer from a fresh one except by `deduplicated` — which is
   * the point: a queued record that reaches the server twice should leave the
   * phone in exactly the state one delivery would have.
   */
  private async findByClientSubmissionId(
    clientSubmissionId: string,
  ): Promise<SubmitRegistrationResult | null> {
    const existing = await this.db.registration.findUnique({
      where: { clientSubmissionId },
      select: {
        id: true,
        citizenId: true,
        referenceNumber: true,
        properties: { select: { id: true } },
      },
    });
    if (!existing) return null;

    return {
      registrationId: existing.id,
      citizenId: existing.citizenId,
      referenceNumber: existing.referenceNumber,
      propertyIds: existing.properties.map((property) => property.id),
      deduplicated: true,
    };
  }

  /** A P2002 naming `clientSubmissionId` — the same submission, twice, at once. */
  private isSubmissionIdConflict(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      ((error.meta?.target as string[] | undefined) ?? []).join(',').includes('clientSubmissionId')
    );
  }

  /** Rehydrates the aggregate, properties and their units included. */
  async findById(id: string): Promise<Registration | null> {
    const row = await this.db.registration.findUnique({
      where: { id },
      include: { properties: { include: { units: true } } },
    });
    return row ? this.toDomain(row) : null;
  }

  /**
   * How many people have already registered this parcel.
   *
   * Reported to the entry form as context ("three neighbours are already
   * registered here") rather than used to refuse the write — a building is one
   * cadastral number shared by everyone inside it.
   */
  async countRegistrationsForParcel(propertyNumber: string): Promise<number> {
    return this.db.propertyEntry.count({
      where: { propertyNumber: propertyNumber.trim() },
    });
  }

  private toDomain(row: {
    id: string;
    citizenId: string;
    referenceNumber: string;
    properties?: Array<Record<string, unknown>>;
  }): Registration {
    return Registration.rehydrate({
      id: row.id,
      citizenId: row.citizenId,
      referenceNumber: row.referenceNumber,
      properties: (row.properties ?? []).map((p) =>
        PropertyEntry.rehydrate({
          occupancyType: p.occupancyType as never,
          landlordName: p.landlordName as string | null,
          landlordPhone: p.landlordPhone as string | null,
          propertyType: p.propertyType as never,
          neighborhood: p.neighborhood as string | null,
          propertyNumber: p.propertyNumber as string | null,
          unitType: p.unitType as never,
          landType: p.landType as never,
          buildingName: p.buildingName as string | null,
          floor: p.floor as string | null,
          side: p.side as string | null,
          tentLocation: p.tentLocation as string | null,
          unitArea: p.unitArea == null ? null : Number(p.unitArea),
          shares: p.shares as number | null,
          sharedRights: (p.sharedRights as string[]) ?? [],
          unitStatus: p.unitStatus as never,
          buildingId: (p.buildingId as string | undefined) ?? null,
          units: ((p.units as Array<Record<string, unknown>>) ?? []).map((unit) => ({
            unitType: unit.unitType as never,
            floor: unit.floor as string,
            side: unit.side as string | null,
            unitArea: Number(unit.unitArea),
            sharedRights: (unit.sharedRights as string[]) ?? [],
            unitStatus: unit.unitStatus as never,
            unitId: (unit.unitId as string | undefined) ?? null,
          })),
          latitude: p.latitude as number | null,
          longitude: p.longitude as number | null,
        }),
      ),
    });
  }

  /**
   * The one place a Prisma error code becomes a domain error. Above this line
   * nothing knows what P2002 is.
   */
  private translate(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? '';

      // No propertyNumber branch: that column is deliberately not unique any
      // more (see migration 0004), so a P2002 naming it would mean the index
      // came back — worth surfacing as the generic conflict rather than as a
      // reassuring message that hides a schema drift.
      if (target.includes('identityDocNumber')) {
        return new ConflictError('هذه الوثيقة مسجّلة مسبقاً لشخص آخر');
      }
      if (target.includes('referenceNumber')) {
        return new ConflictError('تعذّر إنشاء رقم مرجعي فريد — يرجى المحاولة مرة أخرى');
      }
      return new ConflictError('هذه البيانات مسجّلة مسبقاً');
    }
    return error;
  }
}

