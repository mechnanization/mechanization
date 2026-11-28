import { ValidationError } from '../../application/common/exceptions';
import type { LandlordLinkQueueService } from '../../application/features/citizens/landlord-link-queue.service';
import { CitizenLandlordLinksController } from './citizen-landlord-links.controller';

/**
 * The owner-link queue's page, read from the query string (audit PAG-01).
 *
 * `Number(offset ?? 0)` took «1e20» and «Infinity» as numbers, the service's
 * `Math.trunc` kept them, and Postgres refused the OFFSET: a 500 and a Sentry
 * event for a malformed URL. The page now goes through `queryLimit` and
 * `queryOffset`, which refuse it as the 400 it is.
 */
describe('CitizenLandlordLinksController — the owner-link queue page', () => {
  const landlordLinks = { proposals: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
  // The queue reads are `LandlordLinkQueueService`'s since audit GOD-09, and its routes this controller's since GOD-13.
  const controller = new CitizenLandlordLinksController(
    {} as never,
    landlordLinks as unknown as LandlordLinkQueueService,
    {} as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('reads 20 from 0 when no page is sent', async () => {
    await controller.landlordLinks(undefined, undefined);
    expect(landlordLinks.proposals).toHaveBeenCalledWith({ limit: 20, offset: 0 });
  });

  it('caps the page at 100', async () => {
    await controller.landlordLinks('5000', '40');
    expect(landlordLinks.proposals).toHaveBeenCalledWith({ limit: 100, offset: 40 });
  });

  it.each(['1e20', 'Infinity', '-5', '12abc'])('refuses offset=%s with INVALID_QUERY_VALUE, before the database', (value) => {
    let thrown: unknown;
    try {
      controller.landlordLinks(undefined, value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).code).toBe('INVALID_QUERY_VALUE');
    expect(landlordLinks.proposals).not.toHaveBeenCalled();
  });

  it.each(['1e20', 'Infinity'])('refuses limit=%s the same way', (value) => {
    expect(() => controller.landlordLinks(value, undefined)).toThrow(ValidationError);
    expect(landlordLinks.proposals).not.toHaveBeenCalled();
  });
});
