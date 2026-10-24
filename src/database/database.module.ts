import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { ReferenceService } from './reference-sequence.js';

@Global()
@Module({
  providers: [PrismaService, ReferenceService],
  exports: [PrismaService, ReferenceService],
})
export class DatabaseModule {}
