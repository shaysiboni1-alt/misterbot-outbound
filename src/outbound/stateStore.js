"use strict";

const state = {
  schedulerEnabled: false,
  activeCalls: 0,
  launchedAt: 0,
  lastDialAt: 0,
  callStarts: [],
};

function now() { return Date.now(); }

function trimHourWindow() {
  const cutoff = now() - 60 * 60 * 1000;
  state.callStarts = state.callStarts.filter((ts) => ts >= cutoff);
}

function getState() {
  trimHourWindow();
  return {
    schedulerEnabled: state.schedulerEnabled,
    activeCalls: state.activeCalls,
    lastDialAt: state.lastDialAt,
    callsLastHour: state.callStarts.length,
  };
}

function setSchedulerEnabled(v) { state.schedulerEnabled = !!v; }
function markDialStarted() {
  state.lastDialAt = now();
  state.callStarts.push(state.lastDialAt);
  state.activeCalls += 1;
  trimHourWindow();
}
function markCallEnded() { state.activeCalls = Math.max(0, state.activeCalls - 1); }

module.exports = { getState, setSchedulerEnabled, markDialStarted, markCallEnded };
