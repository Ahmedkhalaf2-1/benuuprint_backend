import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/access-control.decorators.js';
import { ReqMeta } from '../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { RequestMeta } from '../../common/types/auth-user.js';
import { AccountRecoveryService } from './account-recovery.service.js';
import { AuthThrottle } from './auth-throttle.decorator.js';
import {
  AcceptInvitationDto,
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  ResetPasswordDto,
} from './dto/recovery.dto.js';

@ApiTags('Password Reset')
@Controller('auth')
export class PasswordResetController {
  constructor(private readonly recovery: AccountRecoveryService) {}

  @Public()
  @AuthThrottle()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset',
    description:
      'Always returns the same response. If an active account matches, a single-use, expiring token is created and handed to the delivery hook (no email provider yet).',
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
    description: "Revokes all of the user's sessions. Tokens are single-use.",
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Invalid/expired/used token or weak password',
  })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  resetPassword(@Body() dto: ResetPasswordDto, @ReqMeta() meta: RequestMeta) {
    return this.recovery.resetPassword(dto.token, dto.newPassword, meta);
  }
}

@ApiTags('Staff Invitations')
@Controller('auth')
export class InvitationAcceptController {
  constructor(private readonly recovery: AccountRecoveryService) {}

  @Public()
  @AuthThrottle()
  @Post('accept-invitation')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Accept a staff invitation and set the initial password',
    description:
      'Activates the INVITED account. The user then logs in normally.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Invalid/expired/used token or weak password',
  })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  acceptInvitation(
    @Body() dto: AcceptInvitationDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.recovery.acceptInvitation(dto.token, dto.password, meta);
  }
}
