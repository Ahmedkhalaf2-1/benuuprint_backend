import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { SampleOptionsDto } from './configurator.controller.js';

const LIVE = { archivedAt: null, isActive: true } as const;
const choices = (values: string[]) => values.map((value) => ({ value }));

@Injectable()
export class ConfiguratorService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active records only; no prices, fees, internal notes or storage details. */
  async sampleOptions(): Promise<SampleOptionsDto> {
    const order = [{ sortOrder: 'asc' as const }, { name: 'asc' as const }];
    const [
      productTypes,
      fabrics,
      sizeScales,
      patterns,
      printMethods,
      accessories,
      components,
      terms,
    ] = await Promise.all([
      this.prisma.productType.findMany({
        where: LIVE,
        orderBy: order,
        select: { id: true, code: true, name: true, description: true },
      }),
      this.prisma.fabric.findMany({
        where: LIVE,
        orderBy: order,
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
            orderBy: order,
            select: { id: true, name: true, hex: true, pantone: true },
          },
          productTypes: {
            where: { isAllowed: true, productType: LIVE },
            select: { productTypeId: true, isRecommended: true },
          },
        },
      }),
      this.prisma.sizeScale.findMany({
        where: LIVE,
        orderBy: order,
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
      }),
      this.prisma.pattern.findMany({
        where: {
          archivedAt: null,
          status: 'ACTIVE',
          currentVersionId: { not: null },
          productType: LIVE,
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          referenceNumber: true,
          code: true,
          name: true,
          fitType: true,
          productTypeId: true,
          currentVersion: { select: { id: true, versionNumber: true } },
        },
      }),
      this.prisma.printMethod.findMany({
        where: LIVE,
        orderBy: order,
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
      }),
      this.prisma.accessory.findMany({
        where: LIVE,
        orderBy: order,
        select: { id: true, code: true, name: true, category: true },
      }),
      this.prisma.componentOption.findMany({
        where: LIVE,
        orderBy: order,
        select: { id: true, code: true, name: true, category: true },
      }),
      this.prisma.termsVersion.findFirst({
        where: { code: 'SAMPLE_TERMS', isActive: true },
        select: {
          id: true,
          code: true,
          version: true,
          title: true,
          content: true,
        },
      }),
    ]);
    return {
      productTypes,
      fabrics,
      sizeScales,
      patterns: patterns.map((p) => ({
        patternId: p.id,
        referenceNumber: p.referenceNumber,
        code: p.code,
        name: p.name,
        fitType: p.fitType,
        productTypeId: p.productTypeId,
        patternVersionId: p.currentVersion!.id,
        versionNumber: p.currentVersion!.versionNumber,
      })),
      printMethods,
      accessories,
      components,
      fitMethods: choices([
        'BENUE_PATTERN',
        'COPY_CUSTOMER_PIECE',
        'CUSTOM_SIZE_CHART',
        'NOT_SURE',
      ]),
      fabricProviders: choices(['CUSTOMER', 'BENUE_PRINT', 'NOT_DECIDED']),
      decorationSides: choices([
        'FRONT',
        'BACK',
        'LEFT_SLEEVE',
        'RIGHT_SLEEVE',
        'OTHER',
      ]),
      measurementUnits: choices(['CM', 'MM', 'IN']),
      terms,
    };
  }
}
