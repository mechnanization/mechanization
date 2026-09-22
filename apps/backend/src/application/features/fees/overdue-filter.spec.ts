import { paymentStatusWhere } from './fees.service';

/**
 * «متأخرة» has to filter the rows it labels.
 *
 * The tab existed on the screen and matched nothing: `PaymentStatus.OVERDUE`
 * is in the enum, `toAdminPaymentItem` derives it for an UNPAID row past its
 * due date, and no code path ever writes it — so `where: { paymentStatus:
 * 'OVERDUE' }` was a predicate over a value the column does not hold. Worse,
 * `filterOptions` built the tab row from `groupBy(['paymentStatus'])`, so the
 * tab was not merely broken but absent, in every municipality, while the rows
 * behind it went on rendering «متأخرة».
 *
 * These assert the translation, and — the part that would otherwise rot — the
 * partition. A late invoice must answer to exactly one tab, because its own
 * status cell names exactly one.
 */
describe('paymentStatusWhere', () => {
  const now = new Date('2026-09-22T00:00:00.000Z');

  it('does not constrain the status when no tab is chosen', () => {
    expect(paymentStatusWhere(undefined, now)).toEqual({});
    expect(paymentStatusWhere('', now)).toEqual({});
  });

  it('reads «متأخرة» as unpaid and past due, never as a stored status', () => {
    expect(paymentStatusWhere('OVERDUE', now)).toEqual({
      paymentStatus: 'UNPAID',
      dueDate: { lt: now },
    });
  });

  it('reads «غير مدفوعة» as unpaid and not yet due', () => {
    expect(paymentStatusWhere('UNPAID', now)).toEqual({
      paymentStatus: 'UNPAID',
      dueDate: { gte: now },
    });
  });

  it('partitions the unpaid rows — no invoice answers to both tabs', () => {
    const unpaid = paymentStatusWhere('UNPAID', now) as {
      dueDate: { gte?: Date; lt?: Date };
    };
    const overdue = paymentStatusWhere('OVERDUE', now) as {
      dueDate: { gte?: Date; lt?: Date };
    };

    // Same column, same boundary, opposite sides, and the boundary belongs to
    // exactly one of them — `gte` on one side and `lt` on the other.
    expect(unpaid.dueDate.gte).toEqual(overdue.dueDate.lt);
    expect(unpaid.dueDate.lt).toBeUndefined();
    expect(overdue.dueDate.gte).toBeUndefined();
  });

  it('passes a genuinely stored status through untouched', () => {
    for (const status of ['PAID', 'PENDING_REVIEW']) {
      expect(paymentStatusWhere(status, now)).toEqual({ paymentStatus: status });
    }
  });

  it('puts no dueDate predicate on a stored status', () => {
    // PAID rows are past their due date more often than not. Carrying the
    // boundary over to them would quietly hide every settled invoice.
    expect(paymentStatusWhere('PAID', now)).not.toHaveProperty('dueDate');
  });
});
