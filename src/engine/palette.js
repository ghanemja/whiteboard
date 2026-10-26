// Phases and colors shared by the canvases (board.js) and the Timeline (timeline.js).
// No imports, so the Timeline's pure functions load under `node --test`.

export const PHASES = [
  { key: "planning", label: "Planning", short: "Plan" },
  { key: "implementation", label: "Implementation", short: "Build" },
  { key: "verification", label: "Verification", short: "Verify" },
  { key: "deployment", label: "Deployment", short: "Ship" },
];

export const MILESTONE = {
  future: { stroke: "#ced4da", fill: "#f8f9fa", dash: "dashed", width: 2, icon: "#adb5bd", head: "#adb5bd" },
  current: { stroke: "#f08c00", fill: "#fff3bf", dash: "solid", width: 3, icon: "#e8590c", head: "#e8590c" },
  done: { stroke: "#2f9e44", fill: "#d3f9d8", dash: "solid", width: 2, icon: "#2f9e44", head: "#2f9e44" },
};

// A technical decision is a diamond (the flowchart shape for a decision), numbered,
// pinned to the components it affects. Its reasoning is in the Plan tab.
export const DECISION = {
  proposed: { stroke: "#6741d9", fill: "#f3f0ff", dash: "dashed" },
  accepted: { stroke: "#6741d9", fill: "#e5dbff", dash: "solid" },
  changed: { stroke: "#1971c2", fill: "#d0ebff", dash: "solid" },
  rejected: { stroke: "#adb5bd", fill: "#f1f3f5", dash: "dotted" },
};

// Proof marks: a decision's check passed or failed (pending is a dashed "?").
export const PROOF = {
  pass: { color: "#2f9e44", glyph: "✓" },
  fail: { color: "#e03131", glyph: "✗" },
};

export const YOU = { stroke: "#c2255c", fill: "#ffdeeb" }; // the user, wherever the board shows them
export const INK = "#1e1e1e";
export const MUTED = "#868e96";
