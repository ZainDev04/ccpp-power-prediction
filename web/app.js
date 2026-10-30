import { makeModel, checkInput } from "./knn.js";

const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

const FIELDS = [
  { id: "AT", name: "temperature", unit: "°C", digits: 1 },
  { id: "V", name: "vacuum", unit: "cm Hg", digits: 1 },
  { id: "AP", name: "pressure", unit: "mbar", digits: 1 },
  { id: "RH", name: "humidity", unit: "%", digits: 1 },
];

// temperature colour: glacier blue through warm grey to furnace amber
const HEAT_STOPS = [[0, [59, 127, 168]], [0.5, [167, 156, 134]], [1, [207, 138, 18]]];
function heatColor(at) {
  const t = Math.min(1, Math.max(0, (at - 2) / 35));
  const i = t <= 0.5 ? 0 : 1;
  const [t0, a] = HEAT_STOPS[i];
  const [t1, b] = HEAT_STOPS[i + 1];
  const f = (t - t0) / (t1 - t0);
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(",")})`;
}

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function quantile(sorted, q) {
  // linear interpolation between order statistics, as in pandas
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const data = await (await fetch("data/model.json")).json();
const model = makeModel(data);
const state = { inputs: FIELDS.map((f) => Number($(f.id).value)), result: null };
// a shared link can carry the conditions: ?c=AT,V,AP,RH
const shared = new URLSearchParams(location.search).get("c")?.split(",").map(Number);
if (shared?.length === 4 && shared.every(Number.isFinite)) {
  FIELDS.forEach((f, j) => {
    const input = $(f.id);
    input.value = Math.min(Number(input.max), Math.max(Number(input.min), shared[j]));
    state.inputs[j] = Number(input.value);
  });
}

// ---------- main chart: every recorded hour, output against temperature
const X_DOMAIN = [0, 46];
const Y_DOMAIN = [416, 500];
const frame = $("plot");
const cloud = $("cloud");
const overlay = $("overlay");
let geom = null;

function layout() {
  const w = frame.clientWidth;
  const h = frame.clientHeight;
  const m = { l: w < 480 ? 44 : 56, r: 16, t: 18, b: 46 };
  const x = (v) => m.l + ((v - X_DOMAIN[0]) / (X_DOMAIN[1] - X_DOMAIN[0])) * (w - m.l - m.r);
  const y = (v) => h - m.b - ((v - Y_DOMAIN[0]) / (Y_DOMAIN[1] - Y_DOMAIN[0])) * (h - m.t - m.b);
  geom = { w, h, m, x, y };
}

function drawCloud() {
  const { w, h, x, y } = geom;
  const dpr = window.devicePixelRatio || 1;
  cloud.width = Math.round(w * dpr);
  cloud.height = Math.round(h * dpr);
  const ctx = cloud.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = 0.38;
  const r = w < 480 ? 1.2 : 1.6;
  for (const [at, pe] of data.hours) {
    ctx.fillStyle = heatColor(at);
    ctx.beginPath();
    ctx.arc(x(at), y(pe), r, 0, Math.PI * 2);
    ctx.fill();
  }
  cloud.classList.add("ready");
}

function drawAxes() {
  const { w, h, m, x, y } = geom;
  overlay.setAttribute("viewBox", `0 0 ${w} ${h}`);
  overlay.querySelectorAll(":scope > :not(desc)").forEach((n) => n.remove());
  const defs = el("defs", {}, overlay);
  const pat = el("pattern", { id: "hatch", width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  el("rect", { width: 7, height: 7, fill: "#F8FAFB" }, pat);
  el("line", { x1: 0, y1: 0, x2: 0, y2: 7, stroke: "#C9D1D7", "stroke-width": 2 }, pat);

  // temperatures no recorded hour reached
  const lo = data.envelope.AT[0];
  const hi = data.observedMaxAT;
  el("rect", { class: "beyond", x: x(hi), y: m.t, width: x(X_DOMAIN[1]) - x(hi), height: h - m.t - m.b }, overlay);
  el("rect", { class: "beyond", x: x(X_DOMAIN[0]), y: m.t, width: x(lo) - x(X_DOMAIN[0]), height: h - m.t - m.b }, overlay);
  const note = el("text", { class: "beyond-label", x: x(hi) + 8, y: m.t + 18 }, overlay);
  note.textContent = w < 480 ? "No data" : "No recorded hours";

  const axis = el("g", { class: "axis" }, overlay);
  for (let v = 420; v <= 500; v += 20) {
    el("line", { x1: m.l, x2: w - m.r, y1: y(v), y2: y(v), "stroke-dasharray": v === 420 ? "" : "2 4" }, axis);
    const t = el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, axis);
    t.textContent = v;
  }
  for (let v = 0; v <= 40; v += 10) {
    const t = el("text", { x: x(v), y: h - m.b + 18, "text-anchor": "middle" }, axis);
    t.textContent = v;
  }
  const xt = el("text", { class: "title", x: w - m.r, y: h - 8, "text-anchor": "end" }, axis);
  xt.textContent = "Air temperature (°C)";
  const yl = el("text", { class: "title", x: 14, y: m.t + (h - m.t - m.b) / 2, "text-anchor": "middle", transform: `rotate(-90 14 ${m.t + (h - m.t - m.b) / 2})` }, axis);
  yl.textContent = "Net output (MW)";
  el("g", { id: "live" }, overlay);
}

function drawLive() {
  const live = overlay.querySelector("#live");
  if (!live || !state.result) return;
  live.replaceChildren();
  const { x, y, w } = geom;
  const at = state.inputs[0];
  const px = x(Math.min(X_DOMAIN[1], at));
  const py = y(state.result.value);
  for (const n of state.result.rows) {
    el("line", { class: "link", x1: px, y1: py, x2: x(n.inputs[0]), y2: y(n.output) }, live);
  }
  for (const n of state.result.rows) {
    el("circle", { class: "ring", cx: x(n.inputs[0]), cy: y(n.output), r: 5 }, live);
  }
  el("circle", { class: "marker", cx: px, cy: py, r: 8 }, live);
  const right = px < w * 0.7;
  const label = el("text", { class: "marker-label", x: px + (right ? 14 : -14), y: py - 12, "text-anchor": right ? "start" : "end" }, live);
  label.textContent = `${fmt(state.result.value)} MW`;
}

// ---------- readout, status and neighbour table
const NAMES = { AT: "temperature", V: "vacuum", AP: "pressure", RH: "humidity" };

function statusText(check) {
  if (check.level === "flagged") {
    const parts = check.outside.map((f) => {
      const j = data.features.indexOf(f);
      const [lo, hi] = data.envelope[f];
      const unit = FIELDS[j].unit;
      return state.inputs[j] > hi ? `${NAMES[f]} above ${fmt(hi)} ${unit}` : `${NAMES[f]} below ${fmt(lo)} ${unit}`;
    });
    return `Outside the recorded data (${parts.join(", ")}). Do not rely on this prediction.`;
  }
  if (check.level === "caution") return "Few similar past hours. Treat this prediction with caution.";
  return "Inside the recorded data. Similar past hours exist.";
}

function render() {
  const r = model.predict(state.inputs);
  state.result = r;
  const check = checkInput(data, state.inputs, r.meanDistance);
  const color = heatColor(state.inputs[0]);
  document.documentElement.style.setProperty("--heat", color);

  $("mw").textContent = fmt(r.value);
  $("band").textContent = check.level === "flagged"
    ? "No error band: the model has not seen these conditions."
    : `Likely range ${fmt(r.value - data.band.below)} to ${fmt(r.value + data.band.above)} MW. Actual output landed inside a band this wide on 90% of test hours.`;
  const status = $("status");
  status.dataset.level = check.level;
  status.textContent = statusText(check);

  FIELDS.forEach((f, j) => {
    const input = $(f.id);
    const v = state.inputs[j];
    const out = $(`${f.id}-out`);
    out.textContent = `${fmt(v, f.digits)} ${f.unit}`;
    out.classList.toggle("outside", check.outside.includes(f.id));
    input.style.setProperty("--fill", `${((v - input.min) / (input.max - input.min)) * 100}%`);
  });

  $("nb-rows").replaceChildren(...r.rows.map((n) => {
    const tr = document.createElement("tr");
    const cells = [`#${n.id}`, ...n.inputs.map((v) => fmt(v, 2)), fmt(n.output, 2)];
    cells.forEach((c, k) => {
      const td = document.createElement("td");
      td.textContent = c;
      if (k > 0) td.className = "num";
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    td.innerHTML = `<div class="share"><i style="width:${Math.max(2, n.weight * 160)}px"></i><span>${Math.round(n.weight * 100)}%</span></div>`;
    tr.appendChild(td);
    return tr;
  }));

  drawLive();
  renderAlarm();
  renderCommit();
}

// ---------- underperformance alarm
function renderAlarm() {
  const box = $("alarm");
  const raw = $("measured").value.trim();
  $("alarm-rule").textContent = `The alarm sounds when output is more than ${fmt(data.alarm)} MW below the prediction. Normal hours stay above that on 95% of test hours.`;
  if (raw === "" || !Number.isFinite(Number(raw))) {
    box.dataset.state = "";
    box.textContent = "Enter a measured output to compare it with the prediction.";
    return;
  }
  const gap = state.result.value - Number(raw);
  if (gap > data.alarm) {
    box.dataset.state = "alarm";
    box.textContent = `Alarm: ${fmt(gap)} MW below what these conditions allow. Check the compressor, the condenser and recent trips.`;
  } else if (gap >= 0) {
    box.dataset.state = "normal";
    box.textContent = `Normal: ${fmt(gap)} MW below the prediction, inside the usual range.`;
  } else {
    box.dataset.state = "normal";
    box.textContent = `Normal: ${fmt(-gap)} MW above the prediction.`;
  }
}

// ---------- grid commitment margin (newsvendor rule on the test errors)
function renderCommit() {
  const ratio = Number($("ratio").value);
  $("ratio-out").textContent = `${fmt(ratio, ratio % 1 ? 1 : 0)} times the sale price`;
  const margin = quantile(data.testErrors, ratio / (ratio + 1));
  const short = data.testErrors.filter((e) => e > margin).length / data.testErrors.length;
  $("commit-mw").textContent = `${fmt(state.result.value - margin)} MW`;
  $("commit-margin").textContent = `${fmt(margin)} MW`;
  $("commit-short").textContent = `${Math.round(short * 100)}%`;
  const input = $("ratio");
  input.style.setProperty("--fill", `${((ratio - input.min) / (input.max - input.min)) * 100}%`);
}

// ---------- results charts
function bars(target, rows, max, unit, digits) {
  // draw at the card's real width so the text stays at its set size
  const W = Math.max(300, Math.min(440, $(target).clientWidth || 400)), rowH = 38, labelW = 128, H = rows.length * rowH;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": rows.map((r) => `${r[0]} ${fmt(r[1], digits)}${unit}`).join(", ") });
  rows.forEach(([name, v, c], i) => {
    const yy = i * rowH;
    const n = el("text", { class: "name", x: 0, y: yy + 23 }, svg);
    n.textContent = name;
    const bw = (v / max) * (W - labelW - 70);
    el("rect", { x: labelW, y: yy + 10, width: bw, height: 18, rx: 3, fill: c }, svg);
    const t = el("text", { class: "val", x: labelW + bw + 8, y: yy + 24 }, svg);
    t.textContent = `${fmt(v, digits)}${unit}`;
  });
  $(target).appendChild(svg);
}

function rmseChart() {
  bars("rmse-chart", [
    ["KNN (chosen)", data.testMetrics.KNN["RMSE (MW)"], "#14212B"],
    ["SVR", data.testMetrics.SVR["RMSE (MW)"], "#5E6E7A"],
    ["Neural network", data.testMetrics.MLP["RMSE (MW)"], "#5E6E7A"],
    ["Guess the average", data.testMetrics["Mean baseline"]["RMSE (MW)"], "#C9D1D7"],
  ], 18, " MW", 2);
  // share of test hours predicted more than 5 MW too high (report table 6)
  bars("over-chart", [
    ["KNN (chosen)", 5.30, "#14212B"],
    ["SVR", 6.87, "#5E6E7A"],
    ["Neural network", 7.76, "#5E6E7A"],
  ], 9, "%", 1);
}

function heatChart() {
  const ex = data.extrapolation;
  const W = Math.max(300, Math.min(460, $("heat-chart").clientWidth || 440)), H = 300, m = { l: 40, r: 118, t: 12, b: 34 };
  const xs = [ex.AT[0], ex.AT[ex.AT.length - 1]];
  const all = [...ex.KNN, ...ex.SVR, ...ex.MLP];
  const ys = [Math.floor(Math.min(...all) / 5) * 5, Math.ceil(Math.max(...all) / 5) * 5];
  const x = (v) => m.l + ((v - xs[0]) / (xs[1] - xs[0])) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((v - ys[0]) / (ys[1] - ys[0])) * (H - m.t - m.b);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Predicted output from 28 to 45 °C for the three models. KNN stays flat near 430 MW, the neural network keeps falling, the SVR rises to 455 MW at 45 °C." });
  el("rect", { x: x(data.observedMaxAT), y: m.t, width: x(xs[1]) - x(data.observedMaxAT), height: H - m.t - m.b, fill: "#E6EBEE" }, svg);
  const nd = el("text", { x: x(data.observedMaxAT) + 6, y: m.t + 14 }, svg);
  nd.textContent = "No recorded hours";
  for (let v = ys[0]; v <= ys[1]; v += 10) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: "#C9D1D7", "stroke-dasharray": "2 4" }, svg);
    const t = el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, svg);
    t.textContent = v;
  }
  for (let v = 30; v <= 45; v += 5) {
    const t = el("text", { x: x(v), y: H - m.b + 18, "text-anchor": "middle" }, svg);
    t.textContent = `${v} °C`;
  }
  const lines = [["SVR", "#A3302A", "SVR"], ["KNN", "#14212B", "KNN"], ["MLP", "#5E6E7A", "Neural network"]];
  const ends = lines.map(([k]) => y(ex[k][ex[k].length - 1]));
  // keep the end labels from overlapping
  const order = ends.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < order.length; k++) if (order[k][0] - order[k - 1][0] < 16) order[k][0] = order[k - 1][0] + 16;
  const labelY = []; order.forEach(([v, i]) => { labelY[i] = v; });
  lines.forEach(([k, c, name], i) => {
    const d = ex.AT.map((a, j) => `${j ? "L" : "M"}${x(a).toFixed(1)},${y(ex[k][j]).toFixed(1)}`).join("");
    el("path", { d, fill: "none", stroke: c, "stroke-width": k === "KNN" ? 2.5 : 2 }, svg);
    const t = el("text", { class: "name", x: W - m.r + 8, y: labelY[i] + 4, fill: c }, svg);
    t.style.fill = c;
    t.textContent = `${name} ${fmt(ex[k][ex[k].length - 1], 0)}`;
  });
  $("heat-chart").appendChild(svg);
}

// ---------- wiring
function syncPresets() {
  const now = state.inputs.join(",");
  document.querySelectorAll("[data-case]").forEach((b) => {
    const v = b.dataset.case.split(",").map(Number).join(",");
    b.setAttribute("aria-pressed", v === now ? "true" : "false");
  });
}

FIELDS.forEach((f, j) => {
  $(f.id).addEventListener("input", (e) => {
    state.inputs[j] = Number(e.target.value);
    syncPresets();
    render();
  });
});
document.querySelectorAll("[data-case]").forEach((b) => {
  b.addEventListener("click", () => {
    const v = b.dataset.case.split(",").map(Number);
    FIELDS.forEach((f, j) => { $(f.id).value = v[j]; });
    state.inputs = v;
    syncPresets();
    render();
  });
});
$("measured").addEventListener("input", renderAlarm);
$("ratio").addEventListener("input", renderCommit);
$("controls").addEventListener("submit", (e) => e.preventDefault());

function redraw() {
  layout();
  drawCloud();
  drawAxes();
  drawLive();
}
new ResizeObserver(() => redraw()).observe(frame);

redraw();
render();
syncPresets();
rmseChart();
heatChart();
