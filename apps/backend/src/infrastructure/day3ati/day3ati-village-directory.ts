import { Inject, Injectable } from '@nestjs/common';
import {
  DAY3ATI_INTEGRATION,
  type Day3atiIntegration,
  type Day3atiVillage,
} from '../../domain/interfaces/day3ati-integration.interface';
import type { Day3atiVillages } from '../../domain/interfaces/day3ati-news.interface';

/** What was read is trusted for a day: a municipality's village does not change from one hour to the next. */
export const DAY3ATI_VILLAGES_TTL_MS = 24 * 60 * 60 * 1000;

/** A municipality missing from the list asks Day3ati again, but never more than this often. */
export const DAY3ATI_VILLAGES_MISS_REFRESH_MS = 60 * 1000;

interface Loaded {
  byTenant: ReadonlyMap<string, Day3atiVillage>;
  at: number;
}

/**
 * Finds a municipality's village on Day3ati from Day3ati's own list, matched by
 * the tenant slug (`externalTenant`). No village id is ever written down on our
 * side: the list is read, kept in memory for a day, and read again when asked
 * (`refresh`) or when a municipality is not in it (once a minute at most).
 *
 * Callers that arrive while the list is being read share that read. A failed
 * read is not kept, and the previous list, if any, is not served in its place:
 * a village id is a routing decision, and a stale one sends News to the wrong
 * place.
 */
@Injectable()
export class Day3atiVillageDirectory implements Day3atiVillages {
  private loaded?: Loaded;
  private inFlight?: Promise<Loaded>;

  constructor(@Inject(DAY3ATI_INTEGRATION) private readonly integration: Day3atiIntegration) {}

  async villageOf(tenantSlug: string): Promise<Day3atiVillage | null> {
    let current = await this.read(false);
    let found = current.byTenant.get(tenantSlug);

    if (!found && Date.now() - current.at >= DAY3ATI_VILLAGES_MISS_REFRESH_MS) {
      current = await this.read(true);
      found = current.byTenant.get(tenantSlug);
    }
    return found ?? null;
  }

  refresh(): void {
    this.loaded = undefined;
  }

  private read(force: boolean): Promise<Loaded> {
    const held = this.loaded;
    if (!force && held && Date.now() - held.at < DAY3ATI_VILLAGES_TTL_MS) return Promise.resolve(held);

    if (!this.inFlight) {
      this.inFlight = this.integration
        .listVillages()
        .then((villages) => {
          const byTenant = new Map<string, Day3atiVillage>();
          for (const village of villages) {
            // The first village of a municipality wins; a second one is Day3ati's mistake, not a reason to flip-flop.
            if (!byTenant.has(village.externalTenant)) byTenant.set(village.externalTenant, village);
          }
          const loaded = { byTenant, at: Date.now() };
          this.loaded = loaded;
          return loaded;
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }
    return this.inFlight;
  }
}
