import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser, RequestMeta } from '../types/auth-user.js';

export type AuthenticatedRequest = Request & { user?: AuthUser };

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new Error('CurrentUser used on a route without authentication');
    }
    return request.user;
  },
);

export function extractRequestMeta(request: Request): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
  };
}

export const ReqMeta = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestMeta =>
    extractRequestMeta(ctx.switchToHttp().getRequest<Request>()),
);
