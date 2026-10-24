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
import { AttachmentResponseDto } from '../assets/dto/asset.dto.js';
import {
  AttachSampleAssetDto,
  SetCustomerVisibilityDto,
  ShareSampleFileDto,
  CreateDecorationDto,
  CreateNoteDto,
  CreateSampleAccessoryDto,
  CreateSampleComponentDto,
  ListNotesQueryDto,
  NoteResponseDto,
  UpdateDecorationDto,
  UpdateSampleAccessoryDto,
  UpdateSampleComponentDto,
} from './dto/sample-spec.dto.js';
import {
  SampleAccessoryDto,
  SampleAttachmentDto,
  SampleComponentDto,
  SampleDecorationDto,
} from './dto/sample.dto.js';
import { SampleNotesService } from './sample-notes.service.js';
import { SampleSpecService } from './sample-spec.service.js';

const locked = () =>
  ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'The sample is no longer a DRAFT',
  });

@ApiTags('Sample Decorations')
@Controller('admin')
export class SampleDecorationsController {
  constructor(private readonly spec: SampleSpecService) {}

  @Post('samples/:sampleId/decorations')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Add a print/embroidery specification',
    description: 'A sample with no decorations means "no print". DRAFT only.',
  })
  @ApiCreatedResponse({ type: SampleDecorationDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @locked()
  create(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreateDecorationDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.createDecoration(sampleId, dto, actor, meta);
  }

  @Patch('sample-decorations/:id')
  @RequirePermissions('samples.manage')
  @ApiOperation({ summary: 'Edit a decoration (DRAFT only)' })
  @ApiOkResponse({ type: SampleDecorationDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @locked()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDecorationDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.updateDecoration(id, dto, actor, meta);
  }

  @Delete('sample-decorations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('samples.manage')
  @ApiOperation({ summary: 'Remove a decoration from a DRAFT sample' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @locked()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.removeDecoration(id, actor, meta);
  }
}

@ApiTags('Samples')
@Controller('admin')
export class SamplePartsController {
  constructor(private readonly spec: SampleSpecService) {}

  @Post('samples/:sampleId/accessories')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary:
      'Select an accessory (catalogue item or free text) for a DRAFT sample',
  })
  @ApiCreatedResponse({ type: SampleAccessoryDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Provide exactly one of accessoryId / customName',
  })
  @locked()
  createAccessory(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreateSampleAccessoryDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.createAccessory(sampleId, dto, actor, meta);
  }

  @Patch('sample-accessories/:id')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Edit quantity/notes of a selected accessory (DRAFT only)',
  })
  @ApiOkResponse({ type: SampleAccessoryDto })
  @locked()
  updateAccessory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSampleAccessoryDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.updateAccessory(id, dto, actor, meta);
  }

  @Delete('sample-accessories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('samples.manage')
  @ApiOperation({ summary: 'Remove an accessory from a DRAFT sample' })
  @ApiNoContentResponse()
  @locked()
  removeAccessory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.removeAccessory(id, actor, meta);
  }

  @Post('samples/:sampleId/components')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Select a label or packaging option (catalogue item or free text)',
  })
  @ApiCreatedResponse({ type: SampleComponentDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Provide exactly one of componentOptionId / customName',
  })
  @locked()
  createComponent(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreateSampleComponentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.createComponent(sampleId, dto, actor, meta);
  }

  @Patch('sample-components/:id')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Edit notes of a selected label/packaging option (DRAFT only)',
  })
  @ApiOkResponse({ type: SampleComponentDto })
  @locked()
  updateComponent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSampleComponentDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.updateComponent(id, dto, actor, meta);
  }

  @Delete('sample-components/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Remove a label/packaging option from a DRAFT sample',
  })
  @ApiNoContentResponse()
  @locked()
  removeComponent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.removeComponent(id, actor, meta);
  }
}

@ApiTags('Sample Assets')
@Controller('admin/samples/:sampleId/assets')
export class SampleAssetsController {
  constructor(private readonly spec: SampleSpecService) {}

  @Get()
  @RequirePermissions('samples.read')
  @ApiOperation({ summary: 'Files attached to a sample (metadata only)' })
  @ApiOkResponse({ type: [SampleAttachmentDto] })
  list(@Param('sampleId', ParseUUIDPipe) sampleId: string) {
    return this.spec.listAssets(sampleId);
  }

  @Post()
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Attach an uploaded file to a DRAFT sample',
    description:
      'Upload first with POST /admin/assets (type REFERENCE, MOCKUP, SIZE_CHART, ARTWORK or OTHER), then attach it here. Requires samples.manage.',
  })
  @ApiCreatedResponse({ type: AttachmentResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Asset type not allowed for samples',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @locked()
  attach(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: AttachSampleAssetDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.attachAsset(sampleId, dto.assetId, actor, meta);
  }

  @Post('share')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Attach a file to the sample and show it to the customer',
    description:
      'Any sample status (mockups and final sample photos are shared after submission). The customer sees it in the portal and can download it. Everything else attached by staff stays hidden from customers.',
  })
  @ApiCreatedResponse({ type: SampleAttachmentDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  share(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: ShareSampleFileDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.shareFile(sampleId, dto.assetId, actor, meta);
  }

  @Patch(':attachmentId/customer-visibility')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Show or hide an attached file for the customer portal',
  })
  @ApiOkResponse({ type: SampleAttachmentDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  setVisibility(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Body() dto: SetCustomerVisibilityDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.setCustomerVisibility(
      sampleId,
      attachmentId,
      dto.customerVisible,
      actor,
      meta,
    );
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('samples.manage')
  @ApiOperation({ summary: 'Detach a file from a DRAFT sample' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @locked()
  detach(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.spec.detachAsset(sampleId, attachmentId, actor, meta);
  }
}

@ApiTags('Sample Notes')
@Controller('admin/samples/:sampleId/notes')
export class SampleNotesController {
  constructor(private readonly notes: SampleNotesService) {}

  @Get()
  @RequirePermissions('samples.read')
  @ApiOperation({ summary: 'Staff notes on a sample (internal by default)' })
  @ApiOkResponse({ type: [NoteResponseDto] })
  list(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Query() query: ListNotesQueryDto,
  ) {
    return this.notes.list(sampleId, query.visibility);
  }

  @Post()
  @RequirePermissions('samples.manage')
  @ApiOperation({ summary: 'Add a note' })
  @ApiCreatedResponse({ type: NoteResponseDto })
  create(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreateNoteDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.notes.create(sampleId, dto, actor, meta);
  }

  @Delete(':noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('samples.manage')
  @ApiOperation({ summary: 'Archive a note (author or administrator)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  archive(
    @Param('sampleId', ParseUUIDPipe) sampleId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.notes.archive(sampleId, noteId, actor, meta);
  }
}
