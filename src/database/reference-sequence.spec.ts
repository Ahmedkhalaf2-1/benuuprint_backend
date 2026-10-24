import { nextReference } from './reference-sequence.js';

function fakeClient(start = 0) {
  let value = start;
  return {
    calls: [] as string[],
    async $queryRaw<T>(
      _q: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T> {
      this.calls.push(String(values[0]));
      value += 1;
      return [{ last_value: value }] as T;
    },
  };
}

describe('nextReference', () => {
  it('formats prefix and zero-padded number', async () => {
    const client = fakeClient();
    expect(await nextReference(client, 'CUS')).toBe('CUS-000001');
    expect(await nextReference(client, 'CUS')).toBe('CUS-000002');
    expect(client.calls).toEqual(['CUS', 'CUS']);
  });

  it('keeps counting past six digits without truncating', async () => {
    expect(await nextReference(fakeClient(999_999), 'BRD')).toBe('BRD-1000000');
  });
});
