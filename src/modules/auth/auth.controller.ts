import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  AllowAuthenticated,
  Public,
} from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { AuthService } from './auth.service.js';
import {
  AuthProfileDto,
  ChangePasswordDto,
  LoginDto,
  LoginResponseDto,
  RefreshDto,
  SessionResponseDto,
  TokenPairDto,
} from './dto/auth.dto.js';
import { AuthThrottle } from './auth-throttle.decorator.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiUnauthorizedResponse({
    type: ErrorResponseDto,
    description: 'Invalid email or password',
  })
  @ApiTooManyRequestsResponse({ type: ErrorResponseDto })
  login(@Body() dto: LoginDto, @ReqMeta() meta: RequestMeta) {
    return this.auth.login(dto.email, dto.password, meta);
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

  @AllowAuthenticated()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session' })
  @ApiNoContentResponse()
  logout(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.auth.logout(user, meta);
  }

  @AllowAuthenticated()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke every session of the current user' })
  @ApiNoContentResponse()
  logoutAll(@CurrentUser() user: AuthUser, @ReqMeta() meta: RequestMeta) {
    return this.auth.logoutAll(user, meta);
  }

  @AllowAuthenticated()
  @Get('me')
  @ApiOperation({
    summary: 'Current user with roles and effective permissions',
  })
  @ApiOkResponse({ type: AuthProfileDto })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.profile(user);
  }

  @AllowAuthenticated()
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
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.auth.changePassword(
      user,
      dto.currentPassword,
      dto.newPassword,
      meta,
    );
  }

  @AllowAuthenticated()
  @Get('sessions')
  @ApiOperation({ summary: "List the current user's active sessions" })
  @ApiOkResponse({ type: [SessionResponseDto] })
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user);
  }

  @AllowAuthenticated()
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Terminate one of the current user's sessions" })
  @ApiNoContentResponse()
  revokeSession(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.auth.revokeSession(user, id, meta);
  }
}
