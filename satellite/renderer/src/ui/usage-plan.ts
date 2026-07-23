// Subscription-plan formatting. Pure functions, no DOM — the usage-view
// header and the app-bar badge both render the tier, so the wording lives
// here once rather than being reinvented in each place.

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
): string {
  const shares = planShares(summary);
  if (shares.length === 0) return "";
  if (shares.length === 1) return shares[0].label;
  return shares.map((s) => `${s.days}d ${s.label}`).join(" · ");
}
