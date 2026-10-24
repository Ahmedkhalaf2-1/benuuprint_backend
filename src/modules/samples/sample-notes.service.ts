import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '../../common/enums/audit-actions.js';
import type { AuthUser, RequestMeta } from '../../common/types/auth-user.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { CreateNoteDto, NoteResponseDto } from './dto/sample-spec.dto.js';

/**
 * Notes are internal by default. CUSTOMER_VISIBLE is stored for the future
 * customer portal, but nothing exposes notes except these staff endpoints: a
 * customer-facing projection must start from `visibility = CUSTOMER_VISIBLE`.
 */
@Injectable()
export class SampleNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    sampleId: string,
    visibility?: 'INTERNAL' | 'CUSTOMER_VISIBLE',
  ): Promise<NoteResponseDto[]> {
    await this.assertSample(sampleId);
    const rows = await this.prisma.sampleNote.findMany({
      where: { sampleId, archivedAt: null, visibility },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { author: { select: { name: true } } },
    });
    return rows.map((n) => ({
      id: n.id,
      visibility: n.visibility,
      content: n.content,
      authorUserId: n.authorUserId,
      authorName: n.author.name,
      createdAt: n.createdAt,
    }));
  }

  async create(
    sampleId: string,
    dto: CreateNoteDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<NoteResponseDto> {
    await this.assertSample(sampleId);
    const note = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sampleNote.create({
        data: {
          sampleId,
          authorUserId: actor.id,
          content: dto.content,
          visibility: dto.visibility ?? 'INTERNAL',
        },
        include: { author: { select: { name: true } } },
      });
      // The note text is deliberately not copied into the audit log.
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SAMPLE_NOTE_CREATED,
          entityType: 'Sample',
          entityId: sampleId,
          metadata: { noteId: created.id, visibility: created.visibility },
          meta,
        },
        tx,
      );
      return created;
    });
    return {
      id: note.id,
      visibility: note.visibility,
      content: note.content,
      authorUserId: note.authorUserId,
      authorName: note.author.name,
      createdAt: note.createdAt,
    };
  }

  /** Authors may archive their own notes; samples.assign holders (admins) may archive any. */
  async archive(
    sampleId: string,
    noteId: string,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<void> {
    const note = await this.prisma.sampleNote.findFirst({
      where: { id: noteId, sampleId },
    });
    if (!note) throw new NotFoundException('Note not found');
    if (note.archivedAt)
      throw new ConflictException('Note is already archived');
    if (
      note.authorUserId !== actor.id &&
      !actor.permissions.has('samples.assign')
    ) {
      throw new ForbiddenException(
        'Only the author or an administrator can archive this note',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.sampleNote.update({
        where: { id: noteId },
        data: { archivedAt: new Date() },
      });
      await this.audit.record(
        {
          actorUserId: actor.id,
          action: AuditAction.SAMPLE_NOTE_ARCHIVED,
          entityType: 'Sample',
          entityId: sampleId,
          metadata: { noteId, visibility: note.visibility },
          meta,
        },
        tx,
      );
    });
  }

  private async assertSample(id: string): Promise<void> {
    if (
      !(await this.prisma.sample.findUnique({
        where: { id },
        select: { id: true },
      }))
    ) {
      throw new NotFoundException('Sample not found');
    }
  }
}
