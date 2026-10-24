import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MulterModule } from '@nestjs/platform-express';
import type { AppConfig } from '../../config/app.config.js';
import { BrandsModule } from '../brands/brands.module.js';
import { AssetsModule } from '../assets/assets.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ConfiguratorModule } from '../configurator/configurator.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { SamplesModule } from '../samples/samples.module.js';
import { ManagementModule } from '../management/management.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { QuotationsModule } from '../quotations/quotations.module.js';
import {
  CustomerOrdersController,
  CustomerOrderTrackingController,
} from './orders/customer-orders.controller.js';
import { CustomerOrdersService } from './orders/customer-orders.service.js';
import { CustomerOrderTrackingService } from './orders/customer-order-tracking.service.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CommercialModule } from '../commercial/commercial.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { CustomerCommercialController } from './commercial/customer-commercial.controller.js';
import { CustomerCommercialService } from './commercial/customer-commercial.service.js';
import { CustomerAccountsAdminController } from './admin/customer-accounts.controller.js';
import { CustomerAccountsAdminService } from './admin/customer-accounts.service.js';
import { CustomerAccountTokensService } from './auth/customer-account-tokens.service.js';
import { CustomerAuthContextService } from './auth/customer-auth-context.service.js';
import { CustomerAuthController } from './auth/customer-auth.controller.js';
import { CustomerAuthGuard } from './auth/customer-auth.guard.js';
import { CustomerAuthService } from './auth/customer-auth.service.js';
import { CustomerRecoveryService } from './auth/customer-recovery.service.js';
import { CustomerSignupService } from './auth/customer-signup.service.js';
import { CustomerVerificationEmailService } from './auth/customer-verification-email.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { CustomerTokenService } from './auth/customer-token.service.js';
import { CustomerConfiguratorController } from './customer-configurator.controller.js';
import {
  CustomerBrandsController,
  CustomerProfileController,
} from './profile/customer-profile.controller.js';
import { CustomerProfileService } from './profile/customer-profile.service.js';
import {
  CustomerSamplesController,
  CustomerTermsController,
} from './samples/customer-samples.controller.js';
import { CustomerSamplesService } from './samples/customer-samples.service.js';

/**
 * Phase 7A: the customer-facing backend. A separate identity (CustomerAccount), separate sessions and
 * a separate token audience/key from staff; every route here is guarded by CustomerAuthGuard and scoped
 * to the signed-in customer. The Sample domain itself is shared with the staff side.
 */
@Module({
  imports: [
    AuthModule,
    NotificationsModule,
    BrandsModule,
    AssetsModule,
    CustomersModule,
    SamplesModule,
    ConfiguratorModule,
    CommercialModule,
    ApprovalsModule,
    PaymentsModule,
    OrdersModule,
    QuotationsModule,
    ManagementModule,
    // this module's own JwtService: customer audience and key (never the staff ones)
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { jwt, customerJwt } = config.getOrThrow<AppConfig>('app');
        return {
          secret: customerJwt.secret,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: jwt.accessTtlSeconds,
            issuer: jwt.issuer,
            audience: customerJwt.audience,
          },
          verifyOptions: {
            algorithms: ['HS256'],
            issuer: jwt.issuer,
            audience: customerJwt.audience,
          },
        };
      },
    }),
    // uploads are held in memory: cap them at the storage limit at the parser, before buffering everything
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        limits: {
          fileSize: config.getOrThrow<AppConfig>('app').storage.maxFileBytes,
          files: 1,
          fields: 10,
        },
      }),
    }),
  ],
  controllers: [
    CustomerAuthController,
    CustomerProfileController,
    CustomerBrandsController,
    CustomerSamplesController,
    CustomerTermsController,
    CustomerConfiguratorController,
    CustomerCommercialController,
    CustomerOrdersController,
    CustomerOrderTrackingController,
    CustomerAccountsAdminController,
  ],
  providers: [
    CustomerTokenService,
    CustomerAuthContextService,
    CustomerAuthGuard,
    CustomerAuthService,
    CustomerAccountTokensService,
    CustomerRecoveryService,
    CustomerSignupService,
    CustomerVerificationEmailService,
    CustomerAccountsAdminService,
    CustomerProfileService,
    CustomerSamplesService,
    CustomerCommercialService,
    CustomerOrdersService,
    CustomerOrderTrackingService,
  ],
})
export class CustomerPortalModule {}
