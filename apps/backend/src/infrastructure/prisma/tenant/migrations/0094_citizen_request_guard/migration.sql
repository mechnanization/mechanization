-- 0094_citizen_request_guard
--
-- == What it is for ==
--
-- The review of PR #121 (2026-10-13), two decisions of the owner the same day.
-- `0092_citizen_requests` is applied and is not edited (docs/database.md,
-- "Applied migrations are immutable"); this file corrects it forward.
--
-- 1. A request whose bill the manager cancels is cancelled with it.
--    0092 let only a request with no bill be cancelled
--    (`citizen_requests_cancelled_without_bill`), on the premise that nothing
--    could cancel a bill. Since the finance audit remediation (0090, 0091 and
--    `FeesService.cancelBill`, «إلغاء الفاتورة») the manager can withdraw a bill
--    nothing was paid on, and a request waiting on it could then be neither
--    paid (a cancelled bill takes no payment), nor rejected or cancelled (the
--    code refuses both while a bill is open), and it held
--    `citizen_requests_one_open_key` for ever: the citizen could never file that
--    request again. The rule becomes: a CANCELLED request has no bill, or a bill
--    that is itself CANCELLED. A CHECK cannot read another table, so the CHECK
--    is dropped and the guard below holds the rule. The code that cancels a
--    bill moves its waiting request to CANCELLED in the same transaction (#122).
--
-- 2. A request's life is held in the database, as the treasury's papers are
--    (0083). 0092's CHECKs pair each status with its stamps, but nothing stopped
--    a COMPLETED request being reopened, a stamp or its bill being rewritten, a
--    row being deleted, or a flat from another card being named.
--    `citizen_requests_guard` (`guard_citizen_request()`) allows exactly what the
--    municipal requests code does:
--
--      INSERT   AWAITING_PAYMENT, or IN_REVIEW (a free type), with no bill and no
--               stamp yet; a flat only on the request's card, and the card only
--               on one of the citizen's files.
--      UPDATE   AWAITING_PAYMENT → IN_REVIEW (paid, or the type made free),
--                                  REJECTED, CANCELLED;
--               IN_REVIEW        → AWAITING_PAYMENT (its payment reversed: a
--                                  bill exists and `paidAt` clears),
--                                  READY_FOR_PICKUP, REJECTED;
--               READY_FOR_PICKUP → COMPLETED.
--               The bill is linked once (NULL to a value, while the request
--               waits for payment) and never changed; `paidAt` moves only
--               between AWAITING_PAYMENT and IN_REVIEW; each step's stamps are
--               written by that step alone (the paper's content, `statement`,
--               `clearanceSnapshot`, `readyAt`, `readyById`, only on
--               IN_REVIEW → READY_FOR_PICKUP, and so on); the number, channel, type,
--               capacity, card, flat, purpose, retry key and filer never change.
--               A COMPLETED, REJECTED or CANCELLED request changes no more.
--               Only `citizenId` may move, in any status: a merge of two files
--               «دمج ملفين» carries a person's requests with them, and its undo
--               brings them back. `updatedAt` follows every write.
--      DELETE   refused: a request is rejected or cancelled, never removed.
--
--    The card check runs on insert only: a merge moves a file's registrations
--    and its requests in separate statements of one transaction.
--
-- == Safety ==
--
-- Nothing reads or writes these tables before the municipal requests code
-- (#122), so wherever this runs ahead of it they are empty; and every row 0092
-- accepted with its CHECK in place also passes the guard's rule for a
-- cancelled request (no bill at all). The guard fires on writes only, so
-- existing rows are not re-judged.
--
-- `DROP CONSTRAINT` is one of the scanner's warnings (scripts/db/destructive-sql.mjs):
-- it loosens nothing here, since the trigger replaces it in this same file.
-- Locks: ACCESS EXCLUSIVE on `citizen_requests` for the drop and SHARE ROW
-- EXCLUSIVE for the trigger, until the file commits; the table is empty or
-- holds a few rows. The function reads `citizen_payments`, `property_entries`,
-- `registrations` and `building_units` when it fires, and takes no lock here.
--
-- The function is pinned to its schema (docs/database.md "A plpgsql function
-- body resolves names when it runs"), so a write in one municipality is never
-- judged against another's bills or cards. Its messages start
-- «citizen request», never «treasury day … is closed». Unqualified DDL (the
-- migrator sets `search_path`); every catalog guard filters on
-- CURRENT_SCHEMA(); idempotent.

ALTER TABLE "citizen_requests" DROP CONSTRAINT IF EXISTS "citizen_requests_cancelled_without_bill";

CREATE OR REPLACE FUNCTION guard_citizen_request() RETURNS TRIGGER AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'citizen request %: a request is rejected or cancelled, never removed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('AWAITING_PAYMENT', 'IN_REVIEW') THEN
      RAISE EXCEPTION 'citizen request %: a request starts AWAITING_PAYMENT or IN_REVIEW, not %', NEW."id", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF num_nonnulls(
         NEW."citizenPaymentId", NEW."paidAt", NEW."readyAt", NEW."readyById", NEW."statement",
         NEW."clearanceSnapshot", NEW."completedAt", NEW."completedById", NEW."rejectedAt",
         NEW."rejectedById", NEW."rejectionReason", NEW."cancelledAt", NEW."cancelledById"
       ) > 0 THEN
      RAISE EXCEPTION 'citizen request %: a new request carries no bill and no stamp', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."propertyEntryId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "property_entries" e
        JOIN "registrations" r ON r."id" = e."registrationId"
       WHERE e."id" = NEW."propertyEntryId" AND r."citizenId" = NEW."citizenId"
    ) THEN
      RAISE EXCEPTION 'citizen request %: card % is not on the citizen''s file', NEW."id", NEW."propertyEntryId"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."buildingUnitId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "building_units" u
       WHERE u."id" = NEW."buildingUnitId" AND u."propertyEntryId" = NEW."propertyEntryId"
    ) THEN
      RAISE EXCEPTION 'citizen request %: flat % is not on card %', NEW."id", NEW."buildingUnitId", NEW."propertyEntryId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF OLD."status" IN ('COMPLETED', 'REJECTED', 'CANCELLED') AND (
      to_jsonb(NEW) - 'citizenId' - 'updatedAt' IS DISTINCT FROM to_jsonb(OLD) - 'citizenId' - 'updatedAt'
    ) THEN
      RAISE EXCEPTION 'citizen request %: a % request changes no more', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
         (OLD."status" = 'AWAITING_PAYMENT' AND NEW."status" IN ('IN_REVIEW', 'REJECTED', 'CANCELLED'))
      OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('READY_FOR_PICKUP', 'REJECTED'))
      OR (OLD."status" = 'IN_REVIEW' AND NEW."status" = 'AWAITING_PAYMENT' AND OLD."citizenPaymentId" IS NOT NULL)
      OR (OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" = 'COMPLETED')
    ) THEN
      RAISE EXCEPTION 'citizen request %: % cannot become %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF (OLD."citizenPaymentId" IS NOT NULL AND NEW."citizenPaymentId" IS DISTINCT FROM OLD."citizenPaymentId")
       OR (OLD."citizenPaymentId" IS NULL AND NEW."citizenPaymentId" IS NOT NULL AND OLD."status" <> 'AWAITING_PAYMENT') THEN
      RAISE EXCEPTION 'citizen request %: its bill is linked once, while it waits for payment', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."paidAt" IS DISTINCT FROM OLD."paidAt" AND NOT (
      (OLD."status", NEW."status") IN (('AWAITING_PAYMENT', 'IN_REVIEW'), ('IN_REVIEW', 'AWAITING_PAYMENT'))
    ) THEN
      RAISE EXCEPTION 'citizen request %: paidAt moves only with the payment', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    -- Each step's stamps are written by that step, and by nothing else: the paper's content only
    -- on IN_REVIEW → READY_FOR_PICKUP, the hand-over only on READY_FOR_PICKUP → COMPLETED, and so on.
    IF (NEW."readyAt", NEW."readyById", NEW."statement", NEW."clearanceSnapshot")
         IS DISTINCT FROM (OLD."readyAt", OLD."readyById", OLD."statement", OLD."clearanceSnapshot")
       AND NOT (OLD."status" = 'IN_REVIEW' AND NEW."status" = 'READY_FOR_PICKUP') THEN
      RAISE EXCEPTION 'citizen request %: the paper is written once, when it is made ready', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."completedAt", NEW."completedById") IS DISTINCT FROM (OLD."completedAt", OLD."completedById")
       AND NOT (OLD."status" = 'READY_FOR_PICKUP' AND NEW."status" = 'COMPLETED') THEN
      RAISE EXCEPTION 'citizen request %: the hand-over is stamped when it is handed over', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."rejectedAt", NEW."rejectedById", NEW."rejectionReason")
         IS DISTINCT FROM (OLD."rejectedAt", OLD."rejectedById", OLD."rejectionReason")
       AND NOT (NEW."status" = 'REJECTED' AND OLD."status" <> 'REJECTED') THEN
      RAISE EXCEPTION 'citizen request %: a rejection is stamped when it is rejected', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW."cancelledAt", NEW."cancelledById") IS DISTINCT FROM (OLD."cancelledAt", OLD."cancelledById")
       AND NOT (NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED') THEN
      RAISE EXCEPTION 'citizen request %: a cancellation is stamped when it is cancelled', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."requestNumber" IS DISTINCT FROM OLD."requestNumber"
      OR NEW."channel" IS DISTINCT FROM OLD."channel"
      OR NEW."requestType" IS DISTINCT FROM OLD."requestType"
      OR NEW."applicantCapacity" IS DISTINCT FROM OLD."applicantCapacity"
      OR NEW."propertyEntryId" IS DISTINCT FROM OLD."propertyEntryId"
      OR NEW."buildingUnitId" IS DISTINCT FROM OLD."buildingUnitId"
      OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
      OR NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId"
      OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'citizen request %: what was asked, for what and by whom does not change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A cancelled request has no bill, or a bill that is itself cancelled (decision of 2026-10-13).
  IF NEW."status" = 'CANCELLED' AND NEW."citizenPaymentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "citizen_payments" p
     WHERE p."id" = NEW."citizenPaymentId" AND p."paymentStatus" = 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'citizen request %: cancelled while its bill % still stands', NEW."id", NEW."citizenPaymentId"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.guard_citizen_request() SET search_path = %I, pg_catalog',
    CURRENT_SCHEMA(), CURRENT_SCHEMA()
  );

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE tg.tgname = 'citizen_requests_guard' AND n.nspname = CURRENT_SCHEMA()
  ) THEN
    CREATE TRIGGER citizen_requests_guard
      BEFORE INSERT OR UPDATE OR DELETE ON "citizen_requests"
      FOR EACH ROW EXECUTE FUNCTION guard_citizen_request();
  END IF;
END
$$;
