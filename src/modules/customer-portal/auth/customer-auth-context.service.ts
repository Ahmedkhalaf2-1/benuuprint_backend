import { Injectable } from '@nestjs/common';
import type { CustomerPrincipal } from '../../../common/types/auth-user.js';
import { PrismaService } from '../../../database/prisma.service.js';

/** A customer who may use the portal: not archived and not blocked (leads and inactive customers may). */
export const portalCustomerAllowed = (customer: {
  archivedAt: Date | null;
  status: string;
}): boolean =>
  !customer.archivedAt &&
  customer.status !== 'ARCHIVED' &&
  customer.status !== 'BLOCKED';

/**
 * Resolves who a (customer account, session) pair is right now. Hits the database on every request, so
 * revocation, disabling the account or blocking the customer takes effect immediately.
 */
@Injectable()
export class CustomerAuthContextService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    accountId: string,
    sessionId: string,
  ): Promise<CustomerPrincipal | null> {
    const session = await this.prisma.customerSession.findFirst({
      where: {
        id: sessionId,
        accountId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        account: {
          status: 'ACTIVE',
          customer: {
            is: {
              archivedAt: null,
              status: { notIn: ['ARCHIVED', 'BLOCKED'] },
            },
          },
        },
      },
      include: { account: { include: { customer: true } } },
    });
    if (!session) return null;
    const { account } = session;
    return {
      accountId: account.id,
      customerId: account.customerId,
      sessionId,
      customerNumber: account.customer.customerNumber,
      name: account.customer.displayName,
      email: account.email,
    };
  }
}
