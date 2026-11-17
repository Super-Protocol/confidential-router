/**
 * The mail feature's own rate-limiter instance.
 *
 * A token of its own rather than `RATE_LIMITER`, for two reasons. One is the
 * rule `InvitesModule` and `FeedbackModule` already follow: separate surfaces
 * get separate budgets, so a busy tenant's `/v1` traffic cannot spend the
 * provider webhook's allowance. The other is specific to this module —
 * `MailModule` is imported by `GraphQLApiModule` alongside `InvitesModule`,
 * which exports `RATE_LIMITER`, and two imports binding the same token into one
 * injector is a collision resolved by import order rather than by intent.
 */
export const MAIL_RATE_LIMITER = Symbol('MAIL_RATE_LIMITER');
