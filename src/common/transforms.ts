import { Transform } from 'class-transformer';

/** Trim and lower-case an email so uniqueness and lookups are case-insensitive. */
export const NormalizeEmail = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );

export const Trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** Query-string booleans: "true"/"false" -> boolean, anything else is left for validation to reject. */
export const ToBoolean = () =>
  Transform(({ value }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  );

/** "+20 (100) 123-4567" / "0020100..." -> "+201001234567". Validation checks the result. */
export function normalizePhone(value: string): string {
  const stripped = value.replace(/[\s\-().]/g, '');
  return stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
}

export const NormalizePhone = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? normalizePhone(value.trim()) : value,
  );

/** "@brand" / " Brand " -> "brand" (Instagram handles are case-insensitive). */
export const NormalizeHandle = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/^@/, '') : value,
  );

/** Upper-case + trim for machine codes. */
export const NormalizeCode = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );
