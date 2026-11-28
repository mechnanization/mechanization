import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { ApplicationModule } from './application/application.module';
import { DomainModule } from './domain/domain.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { PresentationModule } from './presentation/presentation.module';
import { isSchedulerEnabled, validateEnv } from './presentation/config/env.schema';
import { THROTTLERS } from './presentation/http/throttlers';
import { RedisThrottlerStorage } from './infrastructure/cache/redis-throttler-storage';

/**
 * Root composition. The four imports are the four layers, in dependency order —
 * if this list ever needs a fifth, something has escaped its layer.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Boot fails on a missing secret rather than surfacing it as a 500 on the
      // first request that happens to need it.
      validate: validateEnv,
    }),

    /**
     * Synchronous emit, deliberately: listeners run inside the emitting
     * request's AsyncLocalStorage scope, which is how the audit subscriber
     * reaches the right municipality's Prisma client without being handed one.
     * Switching this to a queue would silently break that and start writing
     * audit rows to whichever tenant happened to be current.
     */
    EventEmitterModule.forRoot({ global: true }),

    /**
     * In-process timers, only where a process outlives the request — and only
     * where someone has said so.
     *
     * On Vercel the instance is torn down moments after the response, so a
     * registered `@Cron` would never fire — and worse, it would *look* like it
     * had, because `ScheduleModule` boots without complaint. The schedule moves
     * to Vercel Cron (`vercel.json`), which calls the same job classes over
     * HTTP through `InternalCronController`.
     *
     * This used to read `VERCEL` from the environment directly, which meant "which
     * runtime owns the schedule" was decided by a variable the platform injects
     * and this repository never sets — so on any other host (a container, a VM,
     * `pnpm dev`) the answer was "every process that boots", silently, and
     * there was nowhere to look it up. `SCHEDULER_ENABLED` states it instead.
     * Unset still means `!VERCEL`, so nothing changes until it is set; set it
     * to `false` on every replica but one the moment a second exists.
     *
     * @see isSchedulerEnabled in presentation/config/env.schema.ts
     */
    ...(isSchedulerEnabled() ? [ScheduleModule.forRoot()] : []),

    /**
     * Counted in Redis when `REDIS_URL` is set, so every pm2 process and every
     * replica shares one count (`RedisThrottlerStorage`; audit SEC-04). In
     * memory, per process, while it is unset or down: a client then gets each
     * limit once per process. The throttlers are `THROTTLERS`.
     */
    ThrottlerModule.forRootAsync({
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({ storage, throttlers: THROTTLERS }),
    }),

    DomainModule,
    InfrastructureModule,
    ApplicationModule,
    PresentationModule,
  ],
})
export class AppModule {}
