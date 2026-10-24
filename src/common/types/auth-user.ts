import type { PermissionCode } from '../enums/permissions.js';

/** The authenticated principal attached to the request by the auth guard. */
export interface AuthUser {
  id: string;
  sessionId: string;
  name: string;
  email: string;
  roleCodes: string[];
  permissions: ReadonlySet<PermissionCode>;
}

/**
 * Who performed an action in the shared domain services: a staff user, or (customer: true) a
 * portal customer. `id` is the User id or the Customer id respectively. AuthUser satisfies this.
 */
export interface ActorRef {
  id: string;
  customer?: boolean;
}

/** The authenticated customer portal principal attached to a request by CustomerAuthGuard. */
export interface CustomerPrincipal {
  accountId: string;
  /** Always resolved from the account row, never from a token claim or the request. */
  customerId: string;
  sessionId: string;
  customerNumber: string;
  name: string;
  email: string;
}

/** Splits an actor into the two nullable audit columns. */
export function auditActor(actor: ActorRef | null | undefined): {
  actorUserId: string | null;
  actorCustomerId: string | null;
} {
  if (!actor) return { actorUserId: null, actorCustomerId: null };
  return actor.customer
    ? { actorUserId: null, actorCustomerId: actor.id }
    : { actorUserId: actor.id, actorCustomerId: null };
}

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}
