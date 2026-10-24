import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/access-control.decorators.js';
import {
  CurrentUser,
  ReqMeta,
} from '../../common/decorators/request-context.decorators.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { JobCardService } from './job-card.service.js';
import { QrService } from './qr.service.js';

const OK = (description: string) =>
  ApiOkResponse({
    description,
    schema: { type: 'object', additionalProperties: true },
  });

@ApiTags('Job Cards')
@Controller('admin/factory-jobs')
export class JobCardsAdminController {
  constructor(
    private readonly qr: QrService,
    private readonly cards: JobCardService,
  ) {}

  @Get(':id/qr')
  @RequirePermissions('qr_job_cards.read')
  @ApiOperation({
    summary: 'QR token status and history of a job (never the token itself)',
  })
  @OK('Status')
  status(@Param('id', ParseUUIDPipe) id: string) {
    return this.qr.status(id);
  }

  @Post(':id/qr')
  @RequirePermissions('qr_job_cards.manage')
  @ApiOperation({
    summary: 'Generate the job QR code (audited)',
    description:
      'Returns the token, the URL it encodes and an SVG once. A QR code identifies a job; it never authenticates anybody.',
  })
  @OK('Token, URL and SVG')
  generate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.qr.generate(id, a, m);
  }

  @Post(':id/qr/rotate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('qr_job_cards.manage')
  @ApiOperation({
    summary: 'Replace the QR token: the printed card stops resolving (audited)',
  })
  @OK('New token, URL and SVG')
  rotate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.qr.rotate(id, a, m);
  }

  @Post(':id/qr/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('qr_job_cards.manage')
  @ApiOperation({ summary: 'Revoke the QR token (audited)' })
  @OK('Status')
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() a: AuthUser,
    @ReqMeta() m: RequestMeta,
  ) {
    return this.qr.revoke(id, a, m);
  }

  @Get(':id/job-card')
  @RequirePermissions('qr_job_cards.read')
  @ApiOperation({
    summary: 'Job card data (no prices, payments or customer contact details)',
  })
  @OK('Job card')
  card(@Param('id', ParseUUIDPipe) id: string) {
    return this.cards.card(id);
  }

  @Get(':id/job-card/print')
  @RequirePermissions('qr_job_cards.read')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Printable job card (deterministic HTML with the active QR code inline)',
  })
  @ApiOkResponse({
    description: 'HTML',
    content: { 'text/html': { schema: { type: 'string' } } },
  })
  print(@Param('id', ParseUUIDPipe) id: string) {
    return this.cards.html(id);
  }
}

@ApiTags('Job Cards')
@Controller('factory')
export class QrScanController {
  constructor(private readonly cards: JobCardService) {}

  @Get('qr/:token')
  @RequirePermissions('jobs.read_assigned')
  @ApiOperation({
    summary: 'Resolve a scanned job QR code (staff sign-in required)',
    description:
      'The code only identifies the job. People assigned to it (or with jobs.read_all) receive the job card and their own tasks with allowed actions; anybody else, and any unknown, revoked or rotated code, gets 404.',
  })
  @OK('Job card and my tasks')
  scan(@Param('token') token: string, @CurrentUser() actor: AuthUser) {
    return this.cards.scan(token, actor);
  }
}
