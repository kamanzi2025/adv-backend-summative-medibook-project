// SQL pieces used by more than one model, so each rule is written once. They're
// fixed text, joined to other fixed SQL when the module loads and never to request
// data. Values still go through ? placeholders.

// Revenue = what patients paid minus what was refunded, over the joined
// appointments `a`. Booked rows have no refund yet, hence the inner COALESCE.
// The outer one turns "no appointments at all" (SUM of nothing is NULL) into 0.
const REVENUE_COLLECTED = 'COALESCE(SUM(a.amount_paid - COALESCE(a.refund_amount, 0)), 0)';

module.exports = { REVENUE_COLLECTED };
