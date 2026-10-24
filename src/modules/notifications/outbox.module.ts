import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';

/** Global so any business module can emit events inside its transactions without importing notification code. */
@Global()
@Module({ providers: [OutboxService], exports: [OutboxService] })
export class OutboxModule {}
