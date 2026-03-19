"use strict";

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function toInt(value, fallback) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function splitCsv(value) {
  return safeStr(value)
    .split(",")
    .map((s) => safeStr(s))
    .filter(Boolean);
}

function normalizeFlowRow(row) {
  const stepId = safeStr(row?.step_id || row?.step || row?.id).toLowerCase();
  if (!stepId) return null;

  return {
    step_id: stepId,
    step_name: safeStr(row?.step_name || stepId),
    goal: safeStr(row?.goal),
    allowed_intents: splitCsv(row?.allowed_intents),
    next_if_positive: safeStr(row?.next_if_positive || "").toLowerCase(),
    next_if_objection: safeStr(row?.next_if_objection || "").toLowerCase(),
    next_if_negative: safeStr(row?.next_if_negative || "").toLowerCase(),
    max_questions: Math.max(0, toInt(row?.max_questions, 1)),
    max_sentences: Math.max(1, toInt(row?.max_sentences, 2)),
    notes: safeStr(row?.notes),
  };
}

function defaultFlowRows() {
  return [
    {
      step_id: "opening",
      step_name: "opening",
      goal: "פתיחה קצרה וזיהוי זמינות",
      allowed_intents: [
        "other_general",
        "outbound_not_now",
        "outbound_callback_later",
        "outbound_wrong_person",
      ],
      next_if_positive: "value_hook",
      next_if_objection: "opening",
      next_if_negative: "close",
      max_questions: 1,
      max_sentences: 2,
      notes: "לא למכור, רק לפתוח",
    },
    {
      step_id: "permission_check",
      step_name: "permission_check",
      goal: "קבלת אישור קצר להמשך",
      allowed_intents: [
        "other_general",
        "outbound_not_now",
        "outbound_callback_later",
        "outbound_wrong_person",
      ],
      next_if_positive: "value_hook",
      next_if_objection: "permission_check",
      next_if_negative: "close",
      max_questions: 1,
      max_sentences: 2,
      notes: "מיקרו אישור בלבד",
    },
    {
      step_id: "value_hook",
      step_name: "value_hook",
      goal: "משפט ערך אחד",
      allowed_intents: [
        "outbound_soft_interest",
        "outbound_not_interested",
        "outbound_already_has_solution",
        "outbound_gatekeeper",
      ],
      next_if_positive: "need_discovery",
      next_if_objection: "objection_or_interest",
      next_if_negative: "close",
      max_questions: 1,
      max_sentences: 2,
      notes: "לא יותר ממשפט ערך אחד",
    },
    {
      step_id: "need_discovery",
      step_name: "need_discovery",
      goal: "להבין צורך או כאב",
      allowed_intents: [
        "outbound_soft_interest",
        "qualified_lead",
        "outbound_not_interested",
        "outbound_not_now",
      ],
      next_if_positive: "micro_pitch",
      next_if_objection: "objection_or_interest",
      next_if_negative: "close",
      max_questions: 1,
      max_sentences: 2,
      notes: "שאלה אחת בלבד",
    },
    {
      step_id: "micro_pitch",
      step_name: "micro_pitch",
      goal: "לחבר בין הכאב לערך של הפתרון",
      allowed_intents: [
        "qualified_lead",
        "outbound_ask_price",
        "outbound_send_info",
        "outbound_already_has_solution",
      ],
      next_if_positive: "qualification",
      next_if_objection: "objection_or_interest",
      next_if_negative: "close",
      max_questions: 1,
      max_sentences: 2,
      notes: "עד שניים או שלושה משפטים קצרים",
    },
    {
      step_id: "objection_or_interest",
      step_name: "objection_or_interest",
      goal: "לטפל בהתנגדות אחת בלבד",
      allowed_intents: [
        "outbound_ask_price",
        "outbound_send_info",
        "outbound_already_has_solution",
        "outbound_gatekeeper",
        "outbound_not_now",
      ],
      next_if_positive: "qualification",
      next_if_objection: "objection_or_interest",
      next_if_negative: "close",
      max_questions: 1,
      max_sentences: 2,
      notes: "לא לטפל בכמה התנגדויות יחד",
    },
    {
      step_id: "qualification",
      step_name: "qualification",
      goal: "לקבוע אם זה ליד איכותי",
      allowed_intents: [
        "qualified_lead",
        "outbound_callback_later",
        "outbound_send_info",
      ],
      next_if_positive: "next_step",
      next_if_objection: "objection_or_interest",
      next_if_negative: "close",
      max_questions: 1,
      max_sentences: 2,
      notes: "בדיקת התאמה בלבד",
    },
    {
      step_id: "next_step",
      step_name: "next_step",
      goal: "לקדם לשלב הבא או לקבוע חזרה",
      allowed_intents: ["qualified_lead", "outbound_callback_later"],
      next_if_positive: "close",
      next_if_objection: "close",
      next_if_negative: "close",
      max_questions: 1,
      max_sentences: 2,
      notes: "העברה למנהל או תיאום חזרה",
    },
    {
      step_id: "close",
      step_name: "close",
      goal: "סיום שיחה",
      allowed_intents: ["outbound_not_interested", "other_general"],
      next_if_positive: "close",
      next_if_objection: "close",
      next_if_negative: "close",
      max_questions: 0,
      max_sentences: 2,
      notes: "סיום מנומס",
    },
  ];
}

function buildFlowMap(outboundFlowRows) {
  const rows =
    Array.isArray(outboundFlowRows) && outboundFlowRows.length
      ? outboundFlowRows.map(normalizeFlowRow).filter(Boolean)
      : defaultFlowRows();

  const map = {};
  for (const row of rows) {
    map[row.step_id] = row;
  }

  if (!map.opening) {
    for (const row of defaultFlowRows()) {
      if (!map[row.step_id]) map[row.step_id] = row;
    }
  }

  return map;
}

function intentBucket(intentId) {
  const id = safeStr(intentId).toLowerCase();

  if (!id) return "negative";

  if (
    [
      "qualified_lead",
      "outbound_soft_interest",
      "outbound_ask_price",
      "outbound_send_info",
    ].includes(id)
  ) {
    return "positive";
  }

  if (["outbound_already_has_solution", "outbound_gatekeeper"].includes(id)) {
    return "objection";
  }

  if (["outbound_callback_later", "outbound_not_now"].includes(id)) {
    return "negative";
  }

  if (
    [
      "outbound_not_interested",
      "outbound_wrong_person",
      "other_general",
      "other",
    ].includes(id)
  ) {
    return "negative";
  }

  return "negative";
}

function nextStepFromBucket(stepConfig, bucket) {
  if (!stepConfig) return "close";

  if (bucket === "positive" && stepConfig.next_if_positive) {
    return stepConfig.next_if_positive;
  }
  if (bucket === "objection" && stepConfig.next_if_objection) {
    return stepConfig.next_if_objection;
  }
  if (bucket === "negative" && stepConfig.next_if_negative) {
    return stepConfig.next_if_negative;
  }

  return stepConfig.step_id || "close";
}

function createOutboundConversationState(ssot, runtimeMeta = {}) {
  const flow = buildFlowMap(ssot?.outbound_flow || []);
  const openingStep = flow.opening ? "opening" : Object.keys(flow)[0] || "opening";

  return {
    mode: "outbound",
    started_at: new Date().toISOString(),
    current_step: openingStep,
    last_detected_intent: null,
    last_intent_bucket: null,
    step_history: [openingStep],
    objection_count: 0,
    qualified_candidate: false,
    blocked_intent_count: 0,
    lead_id: safeStr(runtimeMeta?.lead_id),
    campaign_id: safeStr(runtimeMeta?.campaign_id),
    contact_name: safeStr(runtimeMeta?.contact_name),
    business_name: safeStr(runtimeMeta?.business_name),
    flow,
  };
}

function getCurrentStepConfig(state) {
  const stepId = safeStr(state?.current_step).toLowerCase();
  const flow = state?.flow || {};
  return flow[stepId] || flow.opening || null;
}

function shouldEscalateToQualification(intentId) {
  const id = safeStr(intentId).toLowerCase();
  return [
    "qualified_lead",
    "outbound_ask_price",
    "outbound_send_info",
    "outbound_soft_interest",
  ].includes(id);
}

function cloneState(state) {
  return {
    ...state,
    step_history: Array.isArray(state?.step_history) ? state.step_history.slice() : [],
    flow: state?.flow || {},
  };
}

function advanceOutboundConversationState(state, detectedIntent) {
  const nextState = cloneState(state || {});
  const current = getCurrentStepConfig(nextState);
  const intentId = safeStr(detectedIntent?.intent_id || detectedIntent).toLowerCase();
  const bucket = intentBucket(intentId);

  nextState.last_detected_intent = intentId || null;
  nextState.last_intent_bucket = bucket;

  if (!current) {
    nextState.current_step = "close";
    nextState.step_history.push("close");
    return {
      state: nextState,
      allowed: false,
      current_step: "close",
      next_step: "close",
      reason: "missing_flow_config",
      bucket,
    };
  }

  const allowed = current.allowed_intents.includes(intentId);

  if (!allowed) {
    nextState.blocked_intent_count = Number(nextState.blocked_intent_count || 0) + 1;

    if (shouldEscalateToQualification(intentId) && current.step_id !== "qualification") {
      nextState.qualified_candidate = true;
    }

    return {
      state: nextState,
      allowed: false,
      current_step: current.step_id,
      next_step: current.step_id,
      reason: "intent_not_allowed_in_current_step",
      bucket,
    };
  }

  if (bucket === "objection") {
    nextState.objection_count = Number(nextState.objection_count || 0) + 1;
  }

  if (shouldEscalateToQualification(intentId)) {
    nextState.qualified_candidate = true;
  }

  const nextStep = nextStepFromBucket(current, bucket);
  nextState.current_step = nextStep;

  if (
    !nextState.step_history.length ||
    nextState.step_history[nextState.step_history.length - 1] !== nextStep
  ) {
    nextState.step_history.push(nextStep);
  }

  return {
    state: nextState,
    allowed: true,
    current_step: current.step_id,
    next_step: nextStep,
    reason: "advanced",
    bucket,
  };
}

function buildOutboundStepPrompt(state) {
  const step = getCurrentStepConfig(state);
  if (!step) return "";

  const lines = [
    "OUTBOUND_STEP_POLICY (HARD RULE):",
    `- current_step=${safeStr(step.step_id)}`,
    `- step_goal=${safeStr(step.goal)}`,
    `- max_questions=${Math.max(0, Number(step.max_questions || 0))}`,
    `- max_sentences=${Math.max(1, Number(step.max_sentences || 1))}`,
    `- allowed_intents=${(step.allowed_intents || []).join(",")}`,
    `- objection_count=${Number(state?.objection_count || 0)}`,
    `- qualified_candidate=${state?.qualified_candidate ? "true" : "false"}`,
    "- Speak only according to the current step.",
    "- Do not skip ahead to pricing, full pitch, or closing unless the current step allows it.",
    "- Ask only one question in this turn.",
    "- Keep the turn short and natural.",
  ];

  if (safeStr(step.notes)) {
    lines.push(`- step_note=${safeStr(step.notes)}`);
  }

  if (step.step_id === "opening") {
    lines.push("- In opening, only identify yourself briefly and check whether this is a good time.");
    lines.push("- Do not explain the product yet unless the customer asks who is calling.");
  }

  if (step.step_id === "value_hook") {
    lines.push("- Give only one short value sentence tied to missed calls, leads, appointments, service, or sales.");
    lines.push("- Do not list features.");
  }

  if (step.step_id === "need_discovery") {
    lines.push("- Ask one short discovery question about current phone handling, missed calls, lead handling, appointments, service load, or sales flow.");
  }

  if (step.step_id === "micro_pitch") {
    lines.push("- Connect what the customer said to a short relevant benefit in up to two or three short sentences.");
    lines.push("- Do not give a broad company overview.");
  }

  if (step.step_id === "objection_or_interest") {
    lines.push("- Handle only the single current objection.");
    lines.push("- Do not argue and do not answer multiple objections together.");
  }

  if (step.step_id === "qualification") {
    lines.push("- Verify if there is real interest, pain, decision authority, or a clear next step.");
  }

  if (step.step_id === "next_step") {
    lines.push("- Move to a concrete next step only: callback timing or conversation with sales manager.");
  }

  if (step.step_id === "close") {
    lines.push("- Close politely and briefly without trying again.");
  }

  return lines.join("\n").trim();
}

module.exports = {
  createOutboundConversationState,
  advanceOutboundConversationState,
  buildOutboundStepPrompt,
  getCurrentStepConfig,
  buildFlowMap,
  intentBucket,
};
