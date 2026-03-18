"use strict";

function mapOutcome(payload) {
  const event = String(payload?.event || payload?.call_status || "").toLowerCase();
  const intent = String(payload?.intent || "").toLowerCase();
  if (intent.includes("interested") || intent.includes("sales_transfer") || intent.includes("ask_price")) {
    return { status: "qualified_lead", sales_followup_required: "true" };
  }
  if (intent.includes("callback")) {
    return { status: "callback_requested", sales_followup_required: "true" };
  }
  if (intent.includes("not_interested")) {
    return { status: "not_interested", sales_followup_required: "false" };
  }
  if (event === "final") return { status: "completed", sales_followup_required: "false" };
  if (event === "abandoned") return { status: "abandoned", sales_followup_required: "false" };
  return { status: "completed", sales_followup_required: "false" };
}

module.exports = { mapOutcome };
