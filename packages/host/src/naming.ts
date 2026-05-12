/**
 * Convert a freeform display name to a valid system username.
 * Lowercase, spaces→hyphens, strip special chars.
 */
export function nameToUsername(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "vessel";
}
