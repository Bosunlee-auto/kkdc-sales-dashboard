/*
 * CORRECTED 2026-08-06 after live COQL verification against real Sales_Orders
 * records. An earlier pass through this file mis-parsed the field-metadata
 * output and concluded Status was display/actual-value corrupted (e.g.
 * "Ordered to vendor" allegedly stored as "Cancelled"). That was wrong.
 *
 * Live proof: `WHERE Status = 'Cancelled'` returns zero records.
 * `WHERE Status = 'Shipped'` (the plain display string) works correctly.
 * The display value IS the real, stored, filterable value. No translation
 * layer is needed. This file is kept only to centralize the bucket-name
 * constants below, not for value mapping.
 */

function toActual(displayValue) { return displayValue; }
function toDisplay(actualValue) { return actualValue; }

// Your three confirmed funnel buckets (from the Aug 2026 dashboard-scoping session)
const BUCKET = {
  LODGED: 'Order Registered',           // PO received, registered in CRM
  ORDERED_TO_VENDOR: 'Ordered to vendor', // Factory order placed, ESD tracked, not yet shipped
  SHIPPED: 'Shipped'
};

// Confirmed, active pipeline - these count toward Order PO amount
const CONFIRMED_STATUSES = ['Order Registered', 'Ordered to vendor', 'Ship Standby', 'Shipped'];

// Not yet a confirmed order - excluded from Order PO amount, tracked separately
const NOT_CONFIRMED_STATUSES = ['Order On Hold'];

// Superceded: a replacement order already exists and already carries this
// value. Per Bosun's clarification (2026-08-06), this is excluded from
// EVERY total, not tracked as "lost" - counting it anywhere would double
// count against its replacement order.
const SUPERCEDED_STATUSES = ['Superceded'];

// Genuinely cancelled - real lost pipeline, tracked as its own line
const CANCELLED_STATUSES = ['Order Cancelled'];

const EXCEPTION_STATUSES = [...NOT_CONFIRMED_STATUSES, ...SUPERCEDED_STATUSES, ...CANCELLED_STATUSES];

function toActual(displayValue) {
  return DISPLAY_TO_ACTUAL[displayValue];
}

function toDisplay(actualValue) {
  return ACTUAL_TO_DISPLAY[actualValue] || actualValue; // fallback: return as-is if unmapped
}

module.exports = {
  BUCKET,
  CONFIRMED_STATUSES,
  NOT_CONFIRMED_STATUSES,
  SUPERCEDED_STATUSES,
  CANCELLED_STATUSES,
  EXCEPTION_STATUSES,
  toActual,
  toDisplay
};
