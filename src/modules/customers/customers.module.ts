import { Module } from '@nestjs/common';
import { ResponsibilitiesModule } from '../responsibilities/responsibilities.module.js';
import { ContactsService } from './contacts.service.js';
import {
  CustomerContactsController,
  CustomersController,
} from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  imports: [ResponsibilitiesModule],
  controllers: [CustomersController, CustomerContactsController],
  providers: [CustomersService, ContactsService],
  exports: [ContactsService],
})
export class CustomersModule {}
