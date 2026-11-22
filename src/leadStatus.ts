import { normalizePhone } from "./smsCore.js";

export type LeadStatus = "qualified" | "call_first" | "disqualified";

// Decides what happens to an audited lead. Weak-website leads with no usable email but a valid
// phone go to the call list: businesses with no website rarely publish an email address.
export function leadStatus(o: { weak: boolean; email: string | null; verified: boolean; suppressed: boolean; phone: string | null }): LeadStatus {
  if (!o.weak || o.suppressed) return "disqualified";
  if (o.email && o.verified) return "qualified";
  return normalizePhone(o.phone) ? "call_first" : "disqualified";
}
