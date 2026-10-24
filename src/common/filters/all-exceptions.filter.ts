import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  ConflictException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(original: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const exception = translatePrismaError(original);
    const isHttp = exception instanceof HttpException;
    const statusCode = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = 'Internal server error';
    let error = HttpStatus[statusCode] ?? 'Error';
    if (isHttp) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const payload = body as { message?: string | string[]; error?: string };
        message = payload.message ?? exception.message;
        error = payload.error ?? error;
      }
    }

    if (statusCode >= 500) {
      // Never leak internals to the client; full detail goes to the log only.
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponseBody = {
      statusCode,
      error,
      message,
      // the tracking token in a public tracking URL is a credential: never echo it back
      path: request.originalUrl.replace(
        /(\/track\/orders\/)[^/?]+/,
        '$1[token]',
      ),
      timestamp: new Date().toISOString(),
      requestId:
        typeof request.id === 'string' || typeof request.id === 'number'
          ? String(request.id)
          : undefined,
    };
    response.status(statusCode).json(body);
  }
}

/**
 * Map known Prisma request errors to safe HTTP errors so persistence details
 * never reach clients. Duck-typed to keep common/ independent of the database layer.
 */
function translatePrismaError(exception: unknown): unknown {
  if (
    exception instanceof Error &&
    exception.name === 'PrismaClientKnownRequestError'
  ) {
    switch ((exception as { code?: string }).code) {
      case 'P2002':
        return new ConflictException('Resource already exists');
      case 'P2025':
        return new NotFoundException('Resource not found');
      case 'P2034':
        return new ConflictException(
          'Concurrent modification detected, please retry',
        );
    }
  }
  return exception;
}
