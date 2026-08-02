// Subscription-plan formatting for the usage view. Pure functions, no
// DOM, so the tier wording and the day-composition rules are testable on
// their own and stay in one place if another surface ever needs them.
//
// Deliberately NOT shown in the app bar: the tier is slow-moving context,
// not something worth a permanent badge next to the live controls.

/** Tiers the daemon can report, mapped to display text. Anything not
 * listed is title-cased as-is, so a tier Anthropic adds later shows up
 * readably instead of disappearing. */
const PLAN_LABELS: Record<string, string> = {
  max: "Max",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  free: "Free",
  // The daemon's word for "authenticated, but no claude.ai subscription"
  // — an API key or a third-party provider. "API" is what a user would
  // call that; "none" reads like an error.
  none: "API",
};

/** Days the daemon had not yet observed a plan for. Not a tier — it means
 * "we weren't tracking yet", so it is excluded from compositions. */
export const PLAN_UNKNOWN = "unknown";

/** Prefix Anthropic puts on every entitlement string. */
const TIER_PREFIX = "default_claude_";

/** Plan families an entitlement can name. A tier mentioning none of these
 * describes no plan and is not worth displaying — see tierLabel. */
const PLAN_FAMILIES = ["max", "pro", "team", "enterprise", "free"];

/**
 * Display label for a `rate_limit_tier` (e.g. `default_claude_max_5x` →
 * "Max 5x"), or "" when the tier names no plan.
 *
 * Preferred over planLabel() WHERE IT SAYS SOMETHING. The two sources
 * disagree: `subscription` comes from the credential blob's
 * `subscriptionType`, which goes stale after an upgrade — it reads "pro" on
 * an account that has been Max 5x for months — while the entitlement tracks
 * reality. It is also the ONLY field separating Max 5x from Max 20x, and
 * "80% of Max 5x" is not the same amount of work as "80% of Max 20x".
 *
 * But not every tier names a plan. A Pro account reports the generic
 * `default_claude_ai`, and blindly parsing that yielded "Ai" — meaningless,
 * and strictly worse than the "Pro" it displaced. So the tier is used only
 * when it mentions a plan family; otherwise the caller falls back to the
 * subscription.
 *
 * Parsed rather than table-mapped, so a tier Anthropic adds later still
 * reads ("default_claude_max_50x" → "Max 50x") instead of vanishing. A
 * multiplier like "5x" survives title-casing unchanged, which is why it
 * needs no special case.
 */
export function tierLabel(tier: string | undefined): string {
  if (!tier) return "";
  const body = tier.startsWith(TIER_PREFIX) ? tier.slice(TIER_PREFIX.length) : tier;
  const parts = body.split("_").filter((part) => part !== "");
  if (!parts.some((part) => PLAN_FAMILIES.includes(part.toLowerCase()))) return "";
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/** The shape of one plan day as it arrives on the wire. Declared
 * structurally so this module stays free of the API client. */
export interface PlanDayLike {
  subscription: string;
  rate_limit_tier?: string;
}

/** Best available label for one day: the entitlement when the daemon
 * recorded one, else the (possibly stale) subscription. */
function dayLabel(day: PlanDayLike | undefined): string {
  if (!day) return "";
  return tierLabel(day.rate_limit_tier) || planLabel(day.subscription);
}

/**
 * The tier in force at the END of the range — what the footer's numbers
 * are a percentage of.
 *
 * Deliberately not the day composition: "peak 5h 87%" means nothing
 * without the tier it is 87% of, and the tier that makes it meaningful is
 * the one in force when that peak was recorded, not an average over the
 * range.
 */
export function currentTierLabel(days: readonly PlanDayLike[] | undefined): string {
  if (!days || days.length === 0) return "";
  return dayLabel(days[days.length - 1]);
}

/**
 * Per-entitlement shares of a range, largest first. Empty when no day
 * carries an entitlement THAT NAMES A PLAN — which is the signal to fall
 * back to the subscription-based composition. A week on Pro reports the
 * generic `default_claude_ai` every day; counting those would compose a
 * range as "5d Ai" instead of "Pro".
 */
export function planTierShares(days: readonly PlanDayLike[] | undefined): PlanShare[] {
  if (!days) return [];
  const counts = new Map<string, number>();
  for (const d of days) {
    if (!d.rate_limit_tier || tierLabel(d.rate_limit_tier) === "") continue;
    counts.set(d.rate_limit_tier, (counts.get(d.rate_limit_tier) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([subscription, dayCount]) => ({
      subscription,
      label: tierLabel(subscription),
      days: dayCount,
    }))
    .sort((a, b) => b.days - a.days || a.subscription.localeCompare(b.subscription));
}

/** Display label for one tier. Returns "" for unknown/empty so callers
 * can treat "nothing to show" uniformly. */
export function planLabel(subscription: string | undefined): string {
  if (!subscription || subscription === PLAN_UNKNOWN) return "";
  const known = PLAN_LABELS[subscription];
  if (known) return known;
  return subscription.charAt(0).toUpperCase() + subscription.slice(1);
}

/** One tier's share of a range, in days. */
export interface PlanShare {
  subscription: string;
  label: string;
  days: number;
}

/**
 * Break a `plan_summary` into per-tier shares, largest first, dropping
 * unknown days. Ties break alphabetically so the order is stable across
 * renders rather than depending on object key order.
 */
export function planShares(
  summary: Record<string, number> | undefined,
): PlanShare[] {
  if (!summary) return [];
  return Object.entries(summary)
    .filter(([sub, days]) => sub !== PLAN_UNKNOWN && days > 0)
    .map(([subscription, days]) => ({
      subscription,
      label: planLabel(subscription),
      days,
    }))
    .sort((a, b) => b.days - a.days || a.subscription.localeCompare(b.subscription));
}

/**
 * Header text for a range's plan.
 *
 * A range on one tier reads as just that tier ("Max"). A range spanning
 * several reads as its day composition ("40d Max · 10d Pro · 5d Free"),
 * which is why attribution is per-day at every zoom level: the answer to
 * "what plan was I on" only makes sense in whole days.
 *
 * Returns "" when there is nothing worth saying (no data, or every day
 * unknown), so callers can hide the element entirely.
 */
export function planRangeLabel(
  summary: Record<string, number> | undefined,
  days?: readonly PlanDayLike[],
): string {
  // Entitlements first when we have them: a range that ran on Max 5x and
  // then Max 20x reads "max" for every day of it, so the subscription
  // summary would flatten two genuinely different tiers into one label.
  const shares = planTierShares(days);
  return composeShares(shares.length > 0 ? shares : planShares(summary));
}

function composeShares(shares: PlanShare[]): string {
  if (shares.length === 0) return "";
  if (shares.length === 1) return shares[0].label;
  return shares.map((s) => `${s.days}d ${s.label}`).join(" · ");
}
