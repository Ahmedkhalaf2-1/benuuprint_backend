import { Module } from '@nestjs/common';
import { AccessoriesController } from './accessories/accessories.controller.js';
import { AccessoriesService } from './accessories/accessories.service.js';
import { CatalogController } from './catalog/catalog.controller.js';
import { ComponentOptionsController } from './components/component-options.controller.js';
import { ComponentOptionsService } from './components/component-options.service.js';
import {
  FabricColorsController,
  FabricsController,
  ProductFabricsController,
} from './fabrics/fabrics.controller.js';
import { FabricsService } from './fabrics/fabrics.service.js';
import { PatternsController } from './patterns/patterns.controller.js';
import { PatternsService } from './patterns/patterns.service.js';
import { PrintMethodsController } from './print-methods/print-methods.controller.js';
import { PrintMethodsService } from './print-methods/print-methods.service.js';
import { ProductTypesController } from './product-types/product-types.controller.js';
import { ProductTypesService } from './product-types/product-types.service.js';
import {
  SizeOptionsController,
  SizeScalesController,
} from './sizes/size-scales.controller.js';
import { SizesService } from './sizes/sizes.service.js';

@Module({
  controllers: [
    ProductTypesController,
    FabricsController,
    FabricColorsController,
    ProductFabricsController,
    PatternsController,
    PrintMethodsController,
    AccessoriesController,
    ComponentOptionsController,
    SizeScalesController,
    SizeOptionsController,
    CatalogController,
  ],
  providers: [
    ProductTypesService,
    FabricsService,
    PatternsService,
    PrintMethodsService,
    AccessoriesService,
    ComponentOptionsService,
    SizesService,
  ],
})
export class MasterDataModule {}
