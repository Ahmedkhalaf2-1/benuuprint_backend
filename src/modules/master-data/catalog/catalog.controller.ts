import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../common/decorators/access-control.decorators.js';
import { PrismaService } from '../../../database/prisma.service.js';
import {
  CatalogFabricDto,
  CatalogPrintMethodDto,
  CatalogProductTypeDto,
  CatalogSizeScaleDto,
} from './catalog.dto.js';

const LIVE = { archivedAt: null, isActive: true } as const;

/**
 * Read-only reference data shaped for a future customer configurator. Bounded
 * lists, so they are not paginated. Today they require `master_data.read`; the
 * customer-portal principal will reuse the same projections behind its own guard.
 */
@ApiTags('Master Data')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('product-types')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Active product types (configurator view)' })
  @ApiOkResponse({ type: [CatalogProductTypeDto] })
  async productTypes(): Promise<CatalogProductTypeDto[]> {
    return this.prisma.productType.findMany({
      where: LIVE,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        category: true,
      },
    });
  }

  @Get('fabrics')
  @RequirePermissions('master_data.read')
  @ApiOperation({
    summary:
      'Active fabrics with available colours and compatible product types',
  })
  @ApiOkResponse({ type: [CatalogFabricDto] })
  async fabrics(): Promise<CatalogFabricDto[]> {
    const rows = await this.prisma.fabric.findMany({
      where: LIVE,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        composition: true,
        minGsm: true,
        maxGsm: true,
        defaultGsm: true,
        colors: {
          where: { ...LIVE, isAvailable: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, hex: true, pantone: true },
        },
        productTypes: {
          where: { isAllowed: true, productType: LIVE },
          select: { productTypeId: true, isRecommended: true },
        },
      },
    });
    return rows;
  }

  @Get('print-methods')
  @RequirePermissions('master_data.read')
  @ApiOperation({
    summary: 'Active print/decoration methods (no pricing fields)',
  })
  @ApiOkResponse({ type: [CatalogPrintMethodDto] })
  async printMethods(): Promise<CatalogPrintMethodDto[]> {
    return this.prisma.printMethod.findMany({
      where: LIVE,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        description: true,
        supportsFullColor: true,
        maxColors: true,
        minQuantity: true,
      },
    });
  }

  @Get('size-scales')
  @RequirePermissions('master_data.read')
  @ApiOperation({ summary: 'Active size scales with their sizes' })
  @ApiOkResponse({ type: [CatalogSizeScaleDto] })
  async sizeScales(): Promise<CatalogSizeScaleDto[]> {
    return this.prisma.sizeScale.findMany({
      where: LIVE,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        sizes: {
          where: LIVE,
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
          select: { id: true, code: true, name: true },
        },
      },
    });
  }
}
