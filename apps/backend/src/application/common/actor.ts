import { StaffRole } from '../../domain/entities/user.entity';

/**
 * The staff member a service acts for: who, and in which role.
 *
 * Built once, by `@CurrentActor()` (`presentation/decorators/current-actor.decorator.ts`),
 * from the verified session claims, so no controller re-spells it and no
 * service receives a citizen dressed as staff. `role` is the enum, not a
 * string: an audit row's `actorRole` and every role check read it as typed.
 */
export interface StaffActor {
  id: string;
  role: StaffRole;
}
