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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { AssetsService, type UploadedFileInput } from './assets.service.js';
import {
  AssetResponseDto,
  AttachAssetDto,
  AttachmentResponseDto,
  DownloadUrlQueryDto,
  DownloadUrlResponseDto,
  ListAssetsQueryDto,
  PaginatedAssetsDto,
  UpdateAssetDto,
  UploadAssetDto,
} from './dto/asset.dto.js';

@ApiTags('Assets')
@Controller('admin/assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post()
  @RequirePermissions('assets.manage')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload a file (multipart)',
    description:
      'Content is identified by magic bytes (png, jpeg, gif, webp, pdf); the client Content-Type and extension are ignored. Stored privately under a random key.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'type'],
      properties: {
        file: { type: 'string', format: 'binary' },
        type: {
          type: 'string',
          enum: [
            'LOGO',
            'ARTWORK',
            'MOCKUP',
            'REFERENCE',
            'SIZE_CHART',
            'PATTERN',
            'FABRIC_SWATCH',
            'PAYMENT_PROOF',
            'QC_PHOTO',
            'TECH_PACK',
            'LABEL',
            'PACKAGING_REFERENCE',
            'OTHER',
          ],
        },
        description: { type: 'string' },
      },
    },
  })
  @ApiCreatedResponse({ type: AssetResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Missing/empty file or invalid fields',
  })
  @ApiResponse({
    status: 413,
    type: ErrorResponseDto,
    description: 'File too large',
  })
  @ApiResponse({
    status: 415,
    type: ErrorResponseDto,
    description: 'Unsupported file content',
  })
  upload(
    @UploadedFile() file: UploadedFileInput | undefined,
    @Body() dto: UploadAssetDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.assets.upload(file, dto, actor, meta);
  }

  @Get()
  @RequirePermissions('assets.read')
  @ApiOperation({
    summary: 'List assets (optionally those attached to one target)',
  })
  @ApiOkResponse({ type: PaginatedAssetsDto })
  list(@Query() query: ListAssetsQueryDto) {
    return this.assets.list(query);
  }

  @Get(':id')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'Get asset metadata' })
  @ApiOkResponse({ type: AssetResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.get(id);
  }

  @Get(':id/download-url')
  @RequirePermissions('assets.read')
  @ApiOperation({
    summary: 'Get a short-lived private download URL',
    description:
      'The URL itself is the credential and expires quickly; request a new one when needed.',
  })
  @ApiOkResponse({ type: DownloadUrlResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  downloadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DownloadUrlQueryDto,
  ) {
    return this.assets.downloadUrl(id, query.disposition);
  }

  @Patch(':id')
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Update asset type or description' })
  @ApiOkResponse({ type: AssetResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.assets.update(id, dto, actor, meta);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('assets.manage')
  @ApiOperation({ summary: 'Archive an asset (bytes are retained)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Belongs to an approved pattern version',
  })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.assets.archive(id, actor, meta);
  }

  @Get(':id/attachments')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'List what an asset is attached to' })
  @ApiOkResponse({ type: [AttachmentResponseDto] })
  listAttachments(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.listAttachments(id);
  }

  @Post(':id/attachments')
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary:
      'Attach an asset to a customer, brand, fabric, pattern version, product type or print method',
  })
  @ApiCreatedResponse({ type: AttachmentResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Asset or target not found',
  })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Already attached, target archived, or version not DRAFT',
  })
  attach(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachAssetDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.assets.attach(id, dto, actor, meta);
  }

  @Delete(':id/attachments/:attachmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('assets.manage')
  @ApiOperation({
    summary: 'Detach an asset (not allowed for approved pattern versions)',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  detach(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.assets.detach(id, attachmentId, actor, meta);
  }
}
