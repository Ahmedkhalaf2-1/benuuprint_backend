/**
 * Shallow plain-object copy of a validated DTO. DTOs are class instances (the
 * ValidationPipe transforms them), so object spread would trigger lint
 * warnings about losing the prototype; this makes the intent explicit.
 */
export function toPlain<T extends object>(
  value: T,
): T & Record<string, unknown> {
  return Object.assign({}, value) as T & Record<string, unknown>;
}
