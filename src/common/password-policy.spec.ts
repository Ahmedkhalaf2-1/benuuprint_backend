import { isPasswordCompliant } from './password-policy.js';

describe('password policy', () => {
  it.each([
    ['Valid-Passw0rd-123', true],
    ['short1A', false],
    ['alllowercase1234567', false],
    ['ALLUPPERCASE1234567', false],
    ['NoDigitsHereAtAllX', false],
    ['A1' + 'a'.repeat(200), false],
  ])('%s -> %s', (password, expected) => {
    expect(isPasswordCompliant(password)).toBe(expected);
  });
});
