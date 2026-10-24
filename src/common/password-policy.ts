export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_POLICY_MESSAGE = `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters and include a lowercase letter, an uppercase letter and a digit`;

const POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;

export function isPasswordCompliant(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH &&
    POLICY.test(password)
  );
}
