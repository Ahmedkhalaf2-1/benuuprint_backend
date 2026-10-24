import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import {
  CreateStageDefinitionDto,
  CreateWorkflowTemplateDto,
  CreateWorkflowVersionDto,
  ListWorkflowTemplatesQueryDto,
  PaginatedWorkflowTemplatesDto,
  ReplaceWorkflowStagesDto,
  StageDefinitionResponseDto,
  UpdateStageDefinitionDto,
  UpdateWorkflowTemplateDto,
  WorkflowTemplateResponseDto,
  WorkflowVersionResponseDto,
} from './dto/workflow.dto.js';
import { WorkflowTemplatesService } from './workflow-templates.service.js';

@ApiTags('Workflow Templates')
@Controller('admin')
export class WorkflowTemplatesController {
  constructor(private readonly templates: WorkflowTemplatesService) {}

  @Get('workflow-templates')
  @RequirePermissions('workflow_templates.read')
  @ApiOperation({
    summary: 'List workflow templates with their versions and stages',
  })
  @ApiOkResponse({ type: PaginatedWorkflowTemplatesDto })
  list(@Query() query: ListWorkflowTemplatesQueryDto) {
    return this.templates.list(query);
  }

  @Get('workflow-templates/:id')
  @RequirePermissions('workflow_templates.read')
  @ApiOperation({ summary: 'Get a workflow template with all versions' })
  @ApiOkResponse({ type: WorkflowTemplateResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(id);
  }

  @Post('workflow-templates')
  @RequirePermissions('workflow_templates.manage')
  @ApiOperation({
    summary: 'Create a workflow template with version 1 (DRAFT)',
    description:
      'Stages reference production stage definitions by code. Dependencies are explicit (omit for sequential, [] for a parallel start). Activate the version to make it usable by new jobs.',
  })
  @ApiCreatedResponse({ type: WorkflowTemplateResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description:
      'Unknown stage code, cycle, duplicate sequence, QC gate without an inspected stage…',
  })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @Body() dto: CreateWorkflowTemplateDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.templates.create(dto, actor, meta);
  }

  @Patch('workflow-templates/:id')
  @RequirePermissions('workflow_templates.manage')
  @ApiOperation({
    summary:
      'Rename a template, change its description, or make it the default',
  })
  @ApiOkResponse({ type: WorkflowTemplateResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowTemplateDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.templates.update(id, dto, actor, meta);
  }

  @Post('workflow-templates/:id/versions')
  @RequirePermissions('workflow_templates.manage')
  @ApiOperation({
    summary: 'Create a new DRAFT version',
    description:
      'Copies the latest version unless stages are given. Jobs already created stay on the version they were created from.',
  })
  @ApiCreatedResponse({ type: WorkflowVersionResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'A draft already exists',
  })
  createVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWorkflowVersionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.templates.createVersion(id, dto, actor, meta);
  }

  @Get('workflow-template-versions/:id')
  @RequirePermissions('workflow_templates.read')
  @ApiOperation({
    summary: 'Get one workflow version with stages and dependencies',
  })
  @ApiOkResponse({ type: WorkflowVersionResponseDto })
  getVersion(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.getVersion(id);
  }

  @Put('workflow-template-versions/:id/stages')
  @RequirePermissions('workflow_templates.manage')
  @ApiOperation({
    summary:
      'Replace the stages of a DRAFT version (active versions are immutable)',
  })
  @ApiOkResponse({ type: WorkflowVersionResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'Only DRAFT versions are editable',
  })
  replaceStages(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceWorkflowStagesDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.templates.replaceStages(id, dto, actor, meta);
  }

  @Post('workflow-template-versions/:id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('workflow_templates.manage')
  @ApiOperation({
    summary: 'Activate a DRAFT version',
    description:
      'Validates the dependency graph, archives the previously active version and freezes this one. New jobs use the active version.',
  })
  @ApiOkResponse({ type: WorkflowVersionResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.templates.activate(id, actor, meta);
  }
}

@ApiTags('Production Stages')
@Controller('admin/production-stage-definitions')
export class StageDefinitionsController {
  constructor(private readonly templates: WorkflowTemplatesService) {}

  @Get()
  @RequirePermissions('workflow_templates.read')
  @ApiOperation({ summary: 'Configurable production stage definitions' })
  @ApiOkResponse({ type: [StageDefinitionResponseDto] })
  list() {
    return this.templates.listDefinitions();
  }

  @Post()
  @RequirePermissions('workflow_templates.manage')
  @ApiOperation({ summary: 'Add a production stage definition' })
  @ApiCreatedResponse({ type: StageDefinitionResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @Body() dto: CreateStageDefinitionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.templates.createDefinition(dto, actor, meta);
  }

  @Patch(':id')
  @RequirePermissions('workflow_templates.manage')
  @ApiOperation({
    summary: 'Edit a stage definition',
    description:
      'Jobs already running keep the flags they were created with; the change applies to jobs created later.',
  })
  @ApiOkResponse({ type: StageDefinitionResponseDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStageDefinitionDto,
    @CurrentUser() actor: AuthUser,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.templates.updateDefinition(id, dto, actor, meta);
  }
}
