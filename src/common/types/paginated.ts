export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number };
}

export function paginated<T>(
  data: T[],
  page: number,
  pageSize: number,
  total: number,
): Paginated<T> {
  return { data, meta: { page, pageSize, total } };
}
