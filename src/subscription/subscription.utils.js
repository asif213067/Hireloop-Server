import { toObjectId, users } from "../db.js";

// Role-based monthly limits for Free tier
export const USAGE_LIMITS = {
  seeker: {
    applications: 7, // Max 7 job applications per month on Free plan
  },
  recruiter: {
    jobPosts: 5, // Max 5 job posts per month on Free plan
  },
};

// Returns current year and month as "YYYY-MM" (e.g. "2026-11")
export function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// Determines whether the user has an active Pro subscription
export function isProUser(user) {
  if (!user || !user.subscription) return false;
  const { plan, status, currentPeriodEnd } = user.subscription;

  if (plan !== "pro") return false;

  // A plan that has passed its expiration date is no longer Pro
  if (currentPeriodEnd) {
    const expiresAt = new Date(currentPeriodEnd).getTime();
    if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
      return false;
    }
  }

  // Active, trialing, or canceled (before expiration) count as Pro
  if (status === "active" || status === "trialing" || status === "canceled") {
    return true;
  }

  return false;
}

// Checks if the user is allowed to perform the given action ("applications" or "jobPosts")
export function checkUsageLimit(user, type) {
  if (isProUser(user)) {
    return {
      allowed: true,
      isPro: true,
      count: null,
      limit: null,
      remaining: null,
    };
  }

  const role = user?.role === "recruiter" ? "recruiter" : "seeker";
  const limit =
    type === "jobPosts"
      ? USAGE_LIMITS.recruiter.jobPosts
      : USAGE_LIMITS.seeker.applications;

  const currentMonth = getCurrentMonth();
  const usageObj = user?.usage?.[type];

  // If the recorded usage is from a past month, it counts as 0 for this month
  const count =
    usageObj && usageObj.month === currentMonth && typeof usageObj.count === "number"
      ? usageObj.count
      : 0;

  const remaining = Math.max(0, limit - count);
  const allowed = count < limit;

  return {
    allowed,
    isPro: false,
    count,
    limit,
    remaining,
    month: currentMonth,
  };
}

// Atomically increments the user's monthly usage counter in MongoDB
export async function incrementMonthlyUsage(userId, type) {
  const currentMonth = getCurrentMonth();
  const objId = toObjectId(userId);

  // 1. Try to increment if the counter for the current month already exists
  const result = await users.updateOne(
    { _id: objId, [`usage.${type}.month`]: currentMonth },
    { $inc: { [`usage.${type}.count`]: 1 } }
  );

  // 2. If no document matched, this is the first action of the new month; initialize it
  if (result.matchedCount === 0) {
    await users.updateOne(
      { _id: objId },
      {
        $set: {
          [`usage.${type}`]: { count: 1, month: currentMonth },
        },
      }
    );
  }
}
