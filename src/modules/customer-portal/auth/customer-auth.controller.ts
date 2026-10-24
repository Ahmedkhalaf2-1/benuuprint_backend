import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '../../../common/decorators/access-control.decorators.js';
import { ReqMeta } from '../../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import type {
  CustomerPrincipal,
  RequestMeta,
} from '../../../common/types/auth-user.js';
import { AuthThrottle } from '../../auth/auth-throttle.decorator.js';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  TokenPairDto,
} from '../../auth/dto/auth.dto.js';
import {
  AcceptInvitationDto,
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  ResetPasswordDto,
} from '../../auth/dto/recovery.dto.js';
import {
  CustomerLoginResponseDto,
  CustomerMeDto,
} from '../dto/customer-auth.dto.js';
import {
  CustomerAuthConfigDto,
  RegisterCustomerDto,
  RegisterCustomerResponseDto,
  ResendVerificationDto,
  ResendVerificationResponseDto,
  VerifyEmailDto,
  VerifyEmailResponseDto,
} from '../dto/customer-signup.dto.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { CustomerSignupService } from './customer-signup.service.js';
import { CustomerRecoveryService } from './customer-recovery.service.js';
import { CurrentCustomer, CustomerRoute } from './customer-route.decorators.js';

@ApiTags('Customer Auth')
@CustomerRoute()
@Controller('customer/auth')
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly recovery: CustomerRecoveryService,
    private readonly signup: CustomerSignupService,
  ) {}

  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in to the customer portal',
    description:
      'Customer accounts are separate from staff users: staff credentials do not work here and customer tokens are rejected by every staff/admin route.',
  })
  @ApiOkResponse({ type: CustomerLoginResponseDto })
  @ApiUnauthorizedResponse({
    type: ErrorResponseDto,
    description: 'Invalid email or password (also for disabled accounts)',
  })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description:
      'Correct credentials but the email is not verified yet (`error: EMAIL_NOT_VERIFIED`); no session is issued',
  })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  login(@Body() dto: LoginDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.login(dto.email, dto.password, meta);
  }

  @Public()
  @Get('config')
  @ApiOperation({
    summary: 'Public customer-auth settings for the frontend',
    description:
      'Tells the signup UI whether email verification is required (false: register, then sign in directly).',
  })
  @ApiOkResponse({ type: CustomerAuthConfigDto })
  authConfig(): CustomerAuthConfigDto {
    return { emailVerificationRequired: this.signup.emailVerificationRequired };
  }

  @Public()
  @AuthThrottle()
  @Post('register')
  @ApiOperation({
    summary: 'Create a customer account (public self-signup)',
    description:
      'Creates the Customer and its portal account in one transaction, in PENDING_VERIFICATION, and emails a one-time verification link. No session is issued. A taken email answers 409.',
  })
  @ApiCreatedResponse({ type: RegisterCustomerResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Invalid email, weak password or terms/privacy not accepted',
  })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  register(@Body() dto: RegisterCustomerDto, @ReqMeta() meta: RequestMeta) {
    return this.signup.register(dto, meta);
  }

  @Public()
  @AuthThrottle()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the email address with the emailed token',
    description:
      'Activates the account. Tokens are single-use and expire. The customer then signs in normally (no automatic login).',
  })
  @ApiOkResponse({ type: VerifyEmailResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Invalid, expired or already used token',
  })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  verifyEmail(@Body() dto: VerifyEmailDto, @ReqMeta() meta: RequestMeta) {
    return this.signup.verifyEmail(dto.token, meta);
  }

  @Public()
  @AuthThrottle()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a new verification link',
    description:
      'Always returns the same response. Only an account awaiting verification gets a link, at most one per minute and five per hour.',
  })
  @ApiOkResponse({ type: ResendVerificationResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  resendVerification(
    @Body() dto: ResendVerificationDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.signup.resend(dto.email, meta);
  }

  @Public()
  @AuthThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Refresh tokens rotate: the previous one stops working. Replaying an old token revokes the session.',
  })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  refresh(@Body() dto: RefreshDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.refresh(dto.refreshToken, meta);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current customer session' })
  @ApiNoContentResponse()
  logout(
    @CurrentCustomer() me: CustomerPrincipal,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.auth.logout(me, meta);
  }

  @Get('me')
  @ApiOperation({
    summary: 'The authenticated customer (customer-safe identity)',
  })
  @ApiOkResponse({ type: CustomerMeDto })
  me(@CurrentCustomer() me: CustomerPrincipal) {
    return this.auth.me(me);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Change password',
    description:
      'Revokes all sessions, including the current one; log in again afterwards.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  changePassword(
    @CurrentCustomer() me: CustomerPrincipal,
    @Body() dto: ChangePasswordDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.auth.changePassword(
      me,
      dto.currentPassword,
      dto.newPassword,
      meta,
    );
  }

  @Public()
  @AuthThrottle()
  @Post('activate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Accept the portal invitation and set the initial password',
    description: 'Activates the INVITED account. Log in normally afterwards.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Invalid/expired/used token or weak password',
  })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  activate(@Body() dto: AcceptInvitationDto, @ReqMeta() meta: RequestMeta) {
    return this.recovery.acceptInvitation(dto.token, dto.password, meta);
  }

  @Public()
  @AuthThrottle()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset',
    description:
      'Always returns the same response. If an active portal account matches, a single-use expiring token is created and handed to the delivery hook.',
  })
  @ApiOkResponse({ type: ForgotPasswordResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  forgotPassword(@Body() dto: ForgotPasswordDto, @ReqMeta() meta: RequestMeta) {
    return this.recovery.forgotPassword(dto.email, meta);
  }

  @Public()
  @AuthThrottle()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password with a reset token',
    description: 'Revokes all of the customer sessions. Tokens are single-use.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  resetPassword(@Body() dto: ResetPasswordDto, @ReqMeta() meta: RequestMeta) {
    return this.recovery.resetPassword(dto.token, dto.newPassword, meta);
  }
}
