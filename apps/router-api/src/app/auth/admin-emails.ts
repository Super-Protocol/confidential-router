/**
 * Who counts as a deployment operator.
 *
 * `auth.adminEmails` is the whole of the answer — an address list rather than a
 * role, because the `user` table belongs to Better Auth and nothing here may add
 * a column to it (ADR-004 §2).
 *
 * Extracted from {@link AdminGuard} because there is now a second reader: the
 * console has to know whether to render the admin section at all (`me { isAdmin }`,
 * ADR-008 §7), and the resolvers that answer a non-admin a narrower view of the
 * same row have to make the same judgement the guard would. Two spellings of
 * "is this caller an operator" that could disagree is how a screen ends up
 * offering a button whose mutation is refused.
 */
export function isAdminEmail(email: string | undefined | null, adminEmails: readonly string[]): boolean {
  const allowed = adminEmails.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  // An empty list admits nobody: a deployment that has not named its operators
  // refuses everyone, which is the safe direction.
  return !!email && allowed.includes(email.trim().toLowerCase());
}
