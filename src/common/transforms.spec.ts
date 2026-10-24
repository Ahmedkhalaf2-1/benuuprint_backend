import { normalizePhone } from './transforms.js';

describe('normalizePhone', () => {
  it.each([
    ['+20 100 123 4567', '+201001234567'],
    ['0020 (100) 123-4567', '+201001234567'],
    ['01001234567', '01001234567'],
    ['+20.100.123.4567', '+201001234567'],
    ['  +1 415 555 0100 ', '+14155550100'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input.trim())).toBe(expected);
  });
});
