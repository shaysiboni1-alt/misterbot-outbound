"use strict";

const { env } = require("../config/env");
const { getSetting } = require("../ssot/ssotClient");

const DAY_MAP = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function parseAllowedDays(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
      .map((v) => DAY_MAP[v])
      .filter((v) => Number.isInteger(v))
  );
}

function partsInTz(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const out = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

function hhmmToMinutes(v) {
  const m = String(v || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function getScheduleConfig() {
  return {
    controlMode: getSetting("OUTBOUND_CONTROL_MODE", "manual_first"),
    timeZone: getSetting("OUTBOUND_TIMEZONE", env.OUTBOUND_TIMEZONE || env.TIME_ZONE || "Asia/Jerusalem"),
    allowedDays: getSetting("OUTBOUND_ALLOWED_DAYS", env.OUTBOUND_ALLOWED_DAYS || "Sun,Mon,Tue,Wed,Thu"),
    allowedHours: getSetting("OUTBOUND_ALLOWED_HOURS", env.OUTBOUND_ALLOWED_HOURS || "09:00-18:00"),
  };
}

function isWithinAllowedWindow(date = new Date()) {
  const cfg = getScheduleConfig();
  const allowedDays = parseAllowedDays(cfg.allowedDays);
  const parts = partsInTz(date, cfg.timeZone);
  const day = DAY_MAP[String(parts.weekday || "").toLowerCase()];
  if (allowedDays.size && !allowedDays.has(day)) {
    return { ok: false, reason: "outside_allowed_days", meta: { day, timeZone: cfg.timeZone, controlMode: cfg.controlMode } };
  }

  const currentMinutes = hhmmToMinutes(`${parts.hour || "00"}:${parts.minute || "00"}`);
  const rawHours = String(cfg.allowedHours || "").trim();
  if (!rawHours) return { ok: true, meta: { timeZone: cfg.timeZone, controlMode: cfg.controlMode } };

  const [startRaw, endRaw] = rawHours.split("-").map((v) => v.trim());
  const start = hhmmToMinutes(startRaw);
  const end = hhmmToMinutes(endRaw);
  if (start === null || end === null || currentMinutes === null) {
    return { ok: false, reason: "invalid_allowed_hours", meta: { rawHours, timeZone: cfg.timeZone, controlMode: cfg.controlMode } };
  }

  const within = start <= end
    ? currentMinutes >= start && currentMinutes <= end
    : currentMinutes >= start || currentMinutes <= end;

  return within
    ? { ok: true, meta: { timeZone: cfg.timeZone, rawHours, controlMode: cfg.controlMode } }
    : { ok: false, reason: "outside_allowed_hours", meta: { timeZone: cfg.timeZone, rawHours, controlMode: cfg.controlMode } };
}

module.exports = { isWithinAllowedWindow, getScheduleConfig };
