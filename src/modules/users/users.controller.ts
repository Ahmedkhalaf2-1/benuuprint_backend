import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import {
  CreateUserDto,
  ListUsersQueryDto,
  PaginatedUsersDto,
  SetUserRolesDto,
  InvitationResponseDto,
  UpdateUserDto,
  UpdateUserStatusDto,
  UserDetailResponseDto,
} from './dto/user.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('admin / users')
@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  @ApiOperation({ summary: 'List staff users (excludes archived)' })
  @ApiOkResponse({ type: PaginatedUsersDto })
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermissions('users.read')
  @ApiOperation({ summary: 'Get a staff user with effective permissions' })
  @ApiOkResponse({ type: UserDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermissions('users.manage')
  @ApiOperation({
    summary:
      'Create a staff user, optionally with roles and an initial password',
  })
  @ApiCreatedResponse({ type: UserDetailResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Email already in use',
  })
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Update profile fields or reset the password' })
  @ApiOkResponse({ type: UserDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.update(id, dto, actor, meta);
  }

  @Patch(':id/status')
  @RequirePermissions('users.manage')
  @ApiOperation({
    summary: "Change a user's status",
    description:
      'Non-ACTIVE statuses revoke all sessions. Cannot target yourself or the last active SUPER_ADMIN.',
  })
  @ApiOkResponse({ type: UserDetailResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.updateStatus(id, dto.status, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Archive a user (soft delete)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.remove(id, actor, meta);
  }

  @Post(':id/roles')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users.manage')
  @ApiOperation({
    summary: 'Replace the roles of a user',
    description:
      'You can only assign roles whose permissions you hold, and only manage users whose permissions you hold.',
  })
  @ApiOkResponse({ type: UserDetailResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  setRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserRolesDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.setRoles(id, dto.roleIds, actor, meta);
  }

  @Post(':id/invite')
  @HttpCode(HttpStatus.CREATED)
  @ApiTags('Staff Invitations')
  @RequirePermissions('users.manage')
  @ApiOperation({
    summary: 'Invite a staff user to set their own password',
    description:
      'Only for users in status INVITED. Issues a single-use token (expires per INVITATION_TTL_HOURS) and re-issuing revokes the previous one. The token is returned only when EXPOSE_ONE_TIME_TOKENS is enabled; otherwise it goes to the delivery hook only.',
  })
  @ApiCreatedResponse({ type: InvitationResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'User is not in status INVITED',
  })
  invite(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.invite(id, actor, meta);
  }
}
