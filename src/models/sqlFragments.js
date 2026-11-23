// SQL text shared by more than one model, so each rule is written once.
// These are CONSTANT fragments: they are joined to other constant SQL text when a
// module loads, never with request data. Every value still goes through a ? placeholder.

// Revenue collected = what patients paid minus what was refunded, over the joined
// appointments `a`. COALESCE(refund_amount, 0): BOOKED rows have no refund; the outer
// COALESCE turns "no appointments at all" (SUM of nothing = NULL) into 0.
const REVENUE_COLLECTED = 'COALESCE(SUM(a.amount_paid - COALESCE(a.refund_amount, 0)), 0)';

module.exports = { REVENUE_COLLECTED };
