import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { AppConfig } from '../../config/app.config.js';
import {
  InvitationAcceptController,
  PasswordResetController,
} from './account-recovery.controller.js';
import { AccountRecoveryService } from './account-recovery.service.js';
import { AccountTokensService } from './account-tokens.service.js';
import { NoopTokenDelivery, TokenDelivery } from './token-delivery.js';
import { AuthContextService } from './auth-context.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { jwt } = config.getOrThrow<AppConfig>('app');
        return {
          secret: jwt.secret,
          signOptions: {
            algorithm: 'HS256',
            expiresIn: jwt.accessTtlSeconds,
            issuer: jwt.issuer,
            audience: jwt.audience,
          },
          verifyOptions: {
            algorithms: ['HS256'],
            issuer: jwt.issuer,
            audience: jwt.audience,
          },
        };
      },
    }),
  ],
  controllers: [
    AuthController,
    PasswordResetController,
    InvitationAcceptController,
  ],
  providers: [
    AuthService,
    AccountRecoveryService,
    AccountTokensService,
    { provide: TokenDelivery, useClass: NoopTokenDelivery },
    AuthContextService,
    PasswordService,
    TokenService,
    JwtAuthGuard,
  ],
  exports: [
    AuthContextService,
    PasswordService,
    TokenService,
    JwtAuthGuard,
    AccountTokensService,
    TokenDelivery,
  ],
})
export class AuthModule {}
