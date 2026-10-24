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
import { RequirePermissions } from '../../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../../common/types/auth-user.js';
import { PrintMethodsService } from './print-methods.service.js';
import {
  CreatePrintMethodDto,
  ListPrintMethodsQueryDto,
  PaginatedPrintMethodsDto,
  PrintMethodResponseDto,
  UpdatePrintMethodDto,
} from './print-method.dto.js';

@ApiTags('Master Data')
@Controller('admin/print-methods')
export class PrintMethodsController {
  constructor(private readonly service: PrintMethodsService) {}

  @Get()
  @RequirePermissions('master_data.read')
  @ApiOperation({
    summary: 'List print/decoration methods (archived hidden by default)',
  })
  @ApiOkResponse({ type: PaginatedPrintMethodsDto })
  list(@Query() query: ListPrintMethodsQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Get a print/decoration method' })
  @ApiOkResponse({ type: PrintMethodResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Create a print/decoration method' })
  @ApiCreatedResponse({ type: PrintMethodResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Code already in use',
  })
  create(
    @Body() dto: CreatePrintMethodDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.create(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('master_data.manage')
  @ApiOperation({
    summary: 'Update a print/decoration method (code is immutable)',
  })
  @ApiOkResponse({ type: PrintMethodResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePrintMethodDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('master_data.manage')
  @ApiOperation({ summary: 'Archive a print/decoration method (soft delete)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Already archived',
  })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.service.archive(id, actor, meta);
  }
}
