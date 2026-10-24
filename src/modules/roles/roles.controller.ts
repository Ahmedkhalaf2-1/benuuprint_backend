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
  CreateRoleDto,
  ListPermissionsQueryDto,
  ListRolesQueryDto,
  PaginatedPermissionsDto,
  PaginatedRolesDto,
  RoleResponseDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/role.dto.js';
import { RolesService } from './roles.service.js';

@ApiTags('admin / roles')
@Controller('admin/roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.read')
  @ApiOperation({ summary: 'List roles' })
  @ApiOkResponse({ type: PaginatedRolesDto })
  list(@Query() query: ListRolesQueryDto) {
    return this.roles.list(query);
  }

  @Get(':id')
  @RequirePermissions('roles.read')
  @ApiOperation({ summary: 'Get a role with its permissions' })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.roles.get(id);
  }

  @Post()
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Create a custom role' })
  @ApiCreatedResponse({ type: RoleResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Role code already in use',
  })
  create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.roles.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Update role name, description or active flag' })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.roles.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Delete a custom role (soft delete)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'System role, or role still assigned to users',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.roles.remove(id, actor, meta);
  }

  @Post(':id/permissions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('roles.manage')
  @ApiOperation({
    summary: 'Replace the permission set of a role',
    description:
      'You can only grant or revoke permissions you hold yourself. SUPER_ADMIN is immutable.',
  })
  @ApiOkResponse({ type: RoleResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Unknown permission code',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  setPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolePermissionsDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.roles.setPermissions(id, dto.permissionCodes, actor, meta);
  }
}

@ApiTags('admin / permissions')
@Controller('admin/permissions')
export class PermissionsController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('permissions.read')
  @ApiOperation({ summary: 'List the permission catalogue' })
  @ApiOkResponse({ type: PaginatedPermissionsDto })
  list(@Query() query: ListPermissionsQueryDto) {
    return this.roles.listPermissions(query);
  }
}
