import { ForbiddenException } from '@nestjs/common';

/**
 * Privilege-escalation guard: an actor may only grant, revoke or manage
 * permissions they hold themselves.
 */
export function assertActorHoldsAll(
  actorPermissions: ReadonlySet<string>,
  needed: Iterable<string>,
  message: string,
): void {
  for (const code of needed) {
    if (!actorPermissions.has(code)) {
      throw new ForbiddenException(message);
    }
  }
}
