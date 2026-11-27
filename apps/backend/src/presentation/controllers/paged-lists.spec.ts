import {
  CASES_PAGE_DEFAULT,
  CASES_PAGE_MAX,
  FEE_NOTICES_PAGE_DEFAULT,
  FEE_NOTICES_PAGE_MAX,
} from '@mechanization/shared-schemas';
import { ValidationError } from '../../application/common/exceptions';
import type { CasesService } from '../../application/features/cases/cases.service';
import type { FeeNoticesService } from '../../application/features/fees/fee-notices.service';
import { CasesController } from './cases.controller';
import { FeesController } from './fees.controller';

/*
  PAG-02 and PAG-04: «الحالات» and «إشعارات الرسوم» were every row ever written,
  on every visit. Each is now one page, clamped here, before the service is
  asked: absent is the default, too many is the cap, a typo is refused.
*/
describe('the paged lists', () => {
  describe('GET cases (PAG-02)', () => {
    const answer = { items: [], total: 0 };
    const list = jest.fn(async () => answer);
    const controller = new CasesController({ list } as unknown as CasesService);
    const call = (limit?: string, offset?: string) =>
      controller.list(undefined, undefined, undefined, undefined, undefined, undefined, undefined, limit, offset);

    beforeEach(() => list.mockClear());

    it('answers { items, total }, a default page from the start when nothing is asked', async () => {
      await expect(call()).resolves.toBe(answer);
      expect(list).toHaveBeenCalledWith(expect.any(Object), { limit: CASES_PAGE_DEFAULT, offset: 0 });
    });

    it('clamps a page larger than the cap, and passes the offset on', async () => {
      await call('1000000', '40');
      expect(list).toHaveBeenCalledWith(expect.any(Object), { limit: CASES_PAGE_MAX, offset: 40 });
    });

    it('refuses a limit that is not a whole number, before any read', async () => {
      await expect(call('1e9')).rejects.toBeInstanceOf(ValidationError);
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe('GET fees/notices (PAG-04)', () => {
    const answer = { items: [], total: 0 };
    const listNotices = jest.fn(async () => answer);
    const controller = new FeesController(
      null as never,
      null as never,
      null as never,
      null as never,
      { listNotices } as unknown as FeeNoticesService,
      null as never,
      null as never,
      null as never,
    );

    beforeEach(() => listNotices.mockClear());

    it('answers { items, total }, a default page from the start when nothing is asked', async () => {
      await expect(controller.listNotices()).resolves.toBe(answer);
      expect(listNotices).toHaveBeenCalledWith({ limit: FEE_NOTICES_PAGE_DEFAULT, offset: 0 });
    });

    it('clamps a page larger than the cap', async () => {
      await controller.listNotices('5000', '200');
      expect(listNotices).toHaveBeenCalledWith({ limit: FEE_NOTICES_PAGE_MAX, offset: 200 });
    });

    it('refuses a negative offset, before any read', async () => {
      await expect(controller.listNotices('10', '-5')).rejects.toBeInstanceOf(ValidationError);
      expect(listNotices).not.toHaveBeenCalled();
    });
  });
});
