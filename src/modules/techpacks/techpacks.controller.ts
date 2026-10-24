import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { Trim } from '../../common/transforms.js';
import { TechPacksService } from './techpacks.service.js';

const OK = (description: string) =>
  ApiOkResponse({
    description,
    schema: { type: 'object', additionalProperties: true },
  });

class SupersedeDto {
  @ApiProperty()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

@ApiTags('Tech Packs')
@Controller('admin')
export class TechPacksAdminController {
  constructor(private readonly packs: TechPacksService) {}

  @Get('samples/:id/tech-pack')
  @RequirePermissions('tech_packs.read')
  @ApiOperation({
    summary: 'Tech pack of a sample: versions and whether each is stale',
  })
  @OK('Tech pack')
  forSample(@Param('id', ParseUUIDPipe) id: string) {
    return this.packs.forSample(id);
  }

  @Post('samples/:id/tech-pack')
  @RequirePermissions('tech_packs.generate')
  @ApiOperation({
    summary:
      "Generate a tech pack version from the sample's PRE_PRODUCTION specification (audited)",
    description:
      'Creates a DRAFT version with a deterministic PDF in private storage. Needs the frozen pre-production specification (created with the sample production job).',
  })
  @OK('Draft version')
  generateSample(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.packs.generateForSample(id, a, m);
  }

  @Get('orders/:id/tech-pack')
  @RequirePermissions('tech_packs.read')
  @OK('Tech pack')
  forOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.packs.forOrder(id);
  }

  @Post('orders/:id/tech-pack')
  @RequirePermissions('tech_packs.generate')
  @ApiOperation({
    summary:
      "Generate a tech pack version from the order's APPROVED_REFERENCE + current order specification (audited)",
  })
  @OK('Draft version')
  generateOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.packs.generateForOrder(id, a, m);
  }

  @Get('tech-pack-versions/:id')
  @RequirePermissions('tech_packs.read')
  @ApiOperation({ summary: 'A tech pack version with its full frozen content' })
  @OK('Version')
  version(@Param('id', ParseUUIDPipe) id: string) {
    return this.packs.versionView(id);
  }

  @Get('tech-pack-versions/:id/document')
  @RequirePermissions('tech_packs.read')
  @ApiOperation({
    summary: "Short-lived signed download URL of the version's PDF",
  })
  @OK('Download URL')
  document(@Param('id', ParseUUIDPipe) id: string) {
    return this.packs.documentUrl(id);
  }

  @Post('tech-pack-versions/:id/issue')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('tech_packs.issue')
  @ApiOperation({
    summary:
      'Issue a DRAFT: it becomes the version the floor works from; the previous issued one is superseded (audited)',
    description:
      'Refused when the production specification changed since generation. Not a customer approval.',
  })
  @OK('Issued version')
  issue(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.packs.issue(id, a, m);
  }

  @Post('tech-pack-versions/:id/supersede')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('tech_packs.issue')
  @ApiOperation({
    summary:
      'Withdraw an ISSUED version or discard a DRAFT, with a reason (audited)',
  })
  @OK('Superseded version')
  supersede(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupersedeDto,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.packs.supersede(id, dto.reason, a, m);
  }
}

@ApiTags('Tech Packs')
@Controller('staff/jobs')
export class TechPacksStaffController {
  constructor(private readonly packs: TechPacksService) {}

  @Get(':jobId/tech-pack')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({
    summary:
      'The issued tech pack for a job I am assigned to (brand only, no customer identity)',
    description:
      'Read-only. 404 for jobs the caller is not assigned to or when nothing has been issued.',
  })
  @OK('Issued tech pack')
  view(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() a: AuthUser,
  ) {
    return this.packs.floorView(jobId, a);
  }

  @Get(':jobId/tech-pack/document')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({
    summary: 'Short-lived signed download URL of the issued tech pack PDF',
  })
  @OK('Download URL')
  document(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() a: AuthUser,
  ) {
    return this.packs.floorDocumentUrl(jobId, a);
  }
}
