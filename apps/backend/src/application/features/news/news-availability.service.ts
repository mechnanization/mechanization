import { NEWS_MODULE_KEY, type NewsAvailability } from '@mechanization/shared-schemas';
import { Inject, Injectable } from '@nestjs/common';
import { ConflictError } from '../../../domain/errors/domain-error';
import type { Day3atiVillage } from '../../../domain/interfaces/day3ati-integration.interface';
import {
  DAY3ATI_NEWS,
  DAY3ATI_VILLAGES,
  type Day3atiNews,
  type Day3atiVillages,
} from '../../../domain/interfaces/day3ati-news.interface';

/** A municipality whose village lacks the News module is looked at again no sooner than this. */
export const NEWS_AVAILABILITY_RECHECK_MS = 60_000;

/**
 * Whether News is on for a municipality: the question behind hiding the News
 * screens from one whose Day3ati village does not list the module.
 *
 * It is answered from Day3ati's own village list (`DAY3ATI_VILLAGES`, kept for a
 * day), not from anything of ours, and says why when it is no:
 * - `NOT_CONFIGURED`: the four `DAY3ATI_*` settings are not set, so the
 *   integration is off;
 * - `NOT_LINKED`: Day3ati has no village for this municipality;
 * - `MODULE_OFF`: it has one, and `news` is not among its modules.
 *
 * A village that lacks the module is asked about again once a minute at most, so
 * switching News on in Day3ati reaches the portal within a minute rather than a
 * day, without a read of Day3ati on every page.
 *
 * It does not say whether the signed-in user may use News (that is their
 * account and role, and Day3ati's answer to a real call), and when the village
 * list cannot be read at all it refuses with `NEWS_UNAVAILABLE` instead of
 * guessing: the screen leaves the rows where they are.
 */
@Injectable()
export class NewsAvailabilityService {
  private readonly lastRecheck = new Map<string, number>();

  constructor(
    @Inject(DAY3ATI_NEWS) private readonly news: Day3atiNews,
    @Inject(DAY3ATI_VILLAGES) private readonly villages: Day3atiVillages,
  ) {}

  async of(tenantSlug: string, now: number = Date.now()): Promise<NewsAvailability> {
    if (!this.news.isConfigured) return { enabled: false, reason: 'NOT_CONFIGURED' };

    let village = await this.find(tenantSlug);
    if (village && !hasNews(village) && this.mayRecheck(tenantSlug, now)) {
      this.villages.refresh();
      village = await this.find(tenantSlug);
    }

    if (!village) return { enabled: false, reason: 'NOT_LINKED' };
    return hasNews(village) ? { enabled: true, reason: null } : { enabled: false, reason: 'MODULE_OFF' };
  }

  private async find(tenantSlug: string): Promise<Day3atiVillage | null> {
    try {
      return await this.villages.villageOf(tenantSlug);
    } catch {
      // The cause (a URL, a status) is of no use to a screen; the directory has logged what an operator needs.
      throw new ConflictError({ code: 'NEWS_UNAVAILABLE', message: 'Day3ati villages could not be read' });
    }
  }

  private mayRecheck(tenantSlug: string, now: number): boolean {
    const last = this.lastRecheck.get(tenantSlug) ?? 0;
    if (now - last < NEWS_AVAILABILITY_RECHECK_MS) return false;
    this.lastRecheck.set(tenantSlug, now);
    return true;
  }
}

const hasNews = (village: Day3atiVillage): boolean => village.modules.includes(NEWS_MODULE_KEY);
