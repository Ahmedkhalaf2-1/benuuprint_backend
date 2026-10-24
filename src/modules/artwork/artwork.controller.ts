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
import { ArtworkService } from './artwork.service.js';
import {
  ArtworkResponseDto,
  ArtworkVersionResponseDto,
  CreateArtworkDto,
  CreateArtworkVersionDto,
  ListArtworksQueryDto,
  PaginatedArtworksDto,
  UpdateArtworkDto,
  UpdateArtworkVersionDto,
} from './dto/artwork.dto.js';

@ApiTags('Artwork')
@Controller('admin')
export class ArtworkController {
  constructor(private readonly artwork: ArtworkService) {}

  @Get('artworks')
  @RequirePermissions('samples.read')
  @ApiOperation({ summary: 'List artworks (by brand, sample or purpose)' })
  @ApiOkResponse({ type: PaginatedArtworksDto })
  list(@Query() query: ListArtworksQueryDto) {
    return this.artwork.list(query);
  }

  @Get('artworks/:id')
  @RequirePermissions('samples.read')
  @ApiOperation({
    summary: 'Get an artwork with all versions (file metadata only)',
  })
  @ApiOkResponse({ type: ArtworkResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.artwork.get(id);
  }

  @Post('artworks')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Create an artwork with its first (DRAFT) version',
    description:
      "Owned by a brand (reusable across that brand's samples) or by one sample. Approval of a version is recorded through POST /admin/samples/:sampleId/approvals (type ARTWORK).",
  })
  @ApiCreatedResponse({ type: ArtworkResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @Body() dto: CreateArtworkDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.artwork.create(dto, actor, meta);
  }

  @Patch('artworks/:id')
  @RequirePermissions('samples.manage')
  @ApiOperation({ summary: 'Rename an artwork or change its purpose' })
  @ApiOkResponse({ type: ArtworkResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateArtworkDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.artwork.update(id, dto, actor, meta);
  }

  @Delete('artworks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Archive an artwork that no sample decoration uses',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Still used by a decoration',
  })
  archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.artwork.archive(id, actor, meta);
  }

  @Post('artworks/:id/versions')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary: 'Upload a new version (DRAFT)',
    description:
      'Existing versions are never edited. Only one DRAFT version can be open at a time.',
  })
  @ApiCreatedResponse({ type: ArtworkVersionResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'A draft version is still open',
  })
  createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateArtworkVersionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.artwork.createVersion(id, dto, actor, meta);
  }

  @Patch('artwork-versions/:id')
  @RequirePermissions('samples.manage')
  @ApiOperation({
    summary:
      'Edit the notes of a DRAFT version (approved/rejected/superseded are immutable)',
  })
  @ApiOkResponse({ type: ArtworkVersionResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Version is not a draft',
  })
  updateVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateArtworkVersionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.artwork.updateVersion(id, dto, actor, meta);
  }
}
