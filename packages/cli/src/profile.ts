// Eng-review-locked: profile name regex enforced at every CLI boundary.
// `^[a-z][a-z0-9-]{0,30}$` — same regex everywhere a profile name appears.
export const PROFILE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

export class InvalidProfileNameError extends Error {
  constructor(public readonly value: string) {
    super(
      `Invalid profile name: "${value}". Must match ${PROFILE_NAME_RE.source} ` +
        `(start with lowercase letter, then up to 30 chars of lowercase/digits/hyphens).`,
    );
    this.name = "InvalidProfileNameError";
  }
}

export function assertValidProfileName(value: string): string {
  if (!PROFILE_NAME_RE.test(value)) {
    throw new InvalidProfileNameError(value);
  }
  return value;
}

export function isValidProfileName(value: string): boolean {
  return PROFILE_NAME_RE.test(value);
}
