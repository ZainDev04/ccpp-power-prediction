import { makeModel, checkInput } from "./knn.js";

const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const gsap = !REDUCED && window.gsap ? window.gsap : null;
if (gsap && window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);

const FIELDS = [
  { id: "AT", unit: "°C" },
  { id: "V", unit: "cm Hg" },
  { id: "AP", unit: "mbar" },
  { id: "RH", unit: "%" },
];
const NAMES = { AT: "temperature", V: "vacuum", AP: "pressure", RH: "humidity" };

// thermal scale: glacier blue, pale steel, furnace amber
const HEAT_STOPS = [[0, [90, 180, 230]], [0.5, [200, 196, 180]], [1, [242, 163, 58]]];
function heatRGB(at) {
  const t = clamp((at - 2) / 35, 0, 1);
  const i = t <= 0.5 ? 0 : 1;
  const [t0, a] = HEAT_STOPS[i];
  const [t1, b] = HEAT_STOPS[i + 1];
  const f = (t - t0) / (t1 - t0);
  return a.map((c, k) => Math.round(c + (b[k] - c) * f));
}
const heatColor = (at, alpha = 1) => `rgba(${heatRGB(at).join(",")},${alpha})`;

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

// average recorded output per 1 °C band, for the physics story
const bandMean = new Map();
for (const [at, pe] of data.hours) {
  const k = Math.round(at);
  const b = bandMean.get(k) || [0, 0];
  bandMean.set(k, [b[0] + pe, b[1] + 1]);
}
function meanOutputAt(at) {
  const lo = Math.floor(at), hi = lo + 1;
  const m = (k) => { const b = bandMean.get(clamp(k, 3, 35)); return b[0] / b[1]; };
  return m(lo) + (m(hi) - m(lo)) * (at - lo);
}

// typical vacuum, pressure and humidity of training hours near a temperature, for the hero simulation
function typicalAt(at) {
  let n = 0;
  const s = [0, 0, 0];
  for (const r of data.train) {
    if (Math.abs(r[0] - at) < 0.75) { s[0] += r[1]; s[1] += r[2]; s[2] += r[3]; n++; }
  }
  return [at, s[0] / n, s[1] / n, s[2] / n];
}

// ---------- air field: inlet air streaming toward the compressor
function airField(canvas) {
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, parts = [], temp = 18, running = false, raf = 0;
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(clamp((w * h) / 2000, 160, 700));
    parts = Array.from({ length: n }, (_, i) => ({
      x: Math.random() * w, y: Math.random() * h, rank: i / n,
      v: 0.6 + Math.random() * 0.9, len: 10 + Math.random() * 26, phase: Math.random() * 6.28,
      tint: (Math.random() - 0.5) * 6,
    }));
  }
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    // hotter air is thinner: fewer particles stay visible, the rest fade out
    const visible = 1 - 0.6 * clamp((temp - 2) / 35, 0, 1);
    const speed = 1 + 0.5 * clamp((temp - 2) / 35, 0, 1);
    for (const p of parts) {
      p.x += p.v * speed * 1.6;
      const wave = Math.sin(p.x / 140 + p.phase + t / 1600) * 0.35;
      p.y += wave;
      if (p.x - p.len > w) { p.x = -p.len; p.y = Math.random() * h; }
      const fade = clamp((visible - p.rank) * 12, 0, 1);
      if (fade <= 0) continue;
      const g = ctx.createLinearGradient(p.x - p.len, p.y, p.x, p.y);
      g.addColorStop(0, heatColor(temp + p.tint, 0));
      g.addColorStop(1, heatColor(temp + p.tint, 0.95 * fade));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(p.x - p.len, p.y - wave * 8);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    if (running) raf = requestAnimationFrame(frame);
  }
  resize();
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([e]) => {
    if (REDUCED) { frame(0); return; }
    if (e.isIntersecting && !running) { running = true; raf = requestAnimationFrame(frame); }
    if (!e.isIntersecting) { running = false; cancelAnimationFrame(raf); }
  }).observe(canvas);
  return { setTemp(v) { temp = v; if (REDUCED) frame(0); } };
}

// ---------- hero: a simulated day, predicted by the real model
const heroAir = airField($("air"));
{
  const cache = new Map();
  const predictAt = (at) => {
    const k = Math.round(at * 2) / 2;
    if (!cache.has(k)) cache.set(k, model.predict(typicalAt(k)).value);
    return cache.get(k);
  };
  let last = 0;
  const tick = (t) => {
    const at = 19.5 + 13 * Math.sin(t / 2600);
    heroAir.setTemp(at);
    if (t - last > 120) {
      last = t;
      const mw = predictAt(at);
      $("live-at").textContent = fmt(at);
      $("live-mw").textContent = fmt(mw);
      $("live-bar").style.width = `${clamp((mw - 420) / 80, 0, 1) * 100}%`;
      document.documentElement.style.setProperty("--live-heat", heatColor(at));
      $("live-at").style.color = heatColor(at);
    }
    if (!REDUCED) requestAnimationFrame(tick);
  };
  if (REDUCED) tick(0); else requestAnimationFrame(tick);
}

// ---------- physics story: scrolling heats the air
const storyAir = airField($("air2"));
function updateStory() {
  const sec = $("physics");
  const r = sec.getBoundingClientRect();
  const p = clamp(-r.top / (r.height - window.innerHeight), 0, 1);
  const at = 4 + 32 * p;
  $("ph-at").textContent = Math.round(at);
  $("ph-at").style.color = heatColor(at);
  $("ph-mw").textContent = Math.round(meanOutputAt(at));
  $("ph-fill").style.height = `${8 + 92 * p}%`;
  storyAir.setTemp(at);
}

// ---------- predictor chart
const state = { inputs: FIELDS.map((f) => Number($(f.id).value)), result: null, shown: 0, sweep: gsap && window.ScrollTrigger ? 0 : 1 };
const shared = new URLSearchParams(location.search).get("c")?.split(",").map(Number);
if (shared?.length === 4 && shared.every(Number.isFinite)) {
  FIELDS.forEach((f, j) => {
    const input = $(f.id);
    input.value = clamp(shared[j], Number(input.min), Number(input.max));
    state.inputs[j] = Number(input.value);
  });
}

const X_DOMAIN = [0, 46];
const Y_DOMAIN = [416, 500];
const frame = $("plot");
const cloud = $("cloud");
const overlay = $("overlay");
let geom = null;

function layout() {
  const w = frame.clientWidth, h = frame.clientHeight;
  const m = { l: w < 480 ? 44 : 56, r: 16, t: 20, b: 46 };
  const x = (v) => m.l + ((v - X_DOMAIN[0]) / (X_DOMAIN[1] - X_DOMAIN[0])) * (w - m.l - m.r);
  const y = (v) => h - m.b - ((v - Y_DOMAIN[0]) / (Y_DOMAIN[1] - Y_DOMAIN[0])) * (h - m.t - m.b);
  geom = { w, h, m, x, y };
}

function drawCloud() {
  const { w, h, x, y } = geom;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cloud.width = Math.round(w * dpr); cloud.height = Math.round(h * dpr);
  const ctx = cloud.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // the cloud sweeps in from cold to hot the first time it is seen
  const limit = X_DOMAIN[0] + (X_DOMAIN[1] - X_DOMAIN[0]) * state.sweep;
  const r = w < 480 ? 1.2 : 1.6;
  ctx.globalCompositeOperation = "lighter";
  for (const [at, pe] of data.hours) {
    if (at > limit) continue;
    ctx.fillStyle = heatColor(at, 0.3);
    ctx.beginPath();
    ctx.arc(x(at), y(pe), r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawAxes() {
  const { w, h, m, x, y } = geom;
  overlay.setAttribute("viewBox", `0 0 ${w} ${h}`);
  overlay.querySelectorAll(":scope > :not(desc)").forEach((n) => n.remove());
  const defs = el("defs", {}, overlay);
  const pat = el("pattern", { id: "hatch", width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  el("line", { x1: 0, y1: 0, x2: 0, y2: 7, stroke: "rgba(205,225,240,0.10)", "stroke-width": 2 }, pat);
  const lo = data.envelope.AT[0], hi = data.observedMaxAT;
  el("rect", { class: "beyond", x: x(hi), y: m.t, width: x(X_DOMAIN[1]) - x(hi), height: h - m.t - m.b }, overlay);
  el("rect", { class: "beyond", x: x(X_DOMAIN[0]), y: m.t, width: x(lo) - x(X_DOMAIN[0]), height: h - m.t - m.b }, overlay);
  const note = el("text", { class: "beyond-label", x: x(hi) + 8, y: m.t + 18 }, overlay);
  note.textContent = w < 480 ? "No data" : "No recorded hours";
  const axis = el("g", { class: "axis" }, overlay);
  for (let v = 420; v <= 500; v += 20) {
    el("line", { x1: m.l, x2: w - m.r, y1: y(v), y2: y(v), "stroke-dasharray": v === 420 ? "" : "2 5" }, axis);
    el("text", { x: m.l - 10, y: y(v) + 4, "text-anchor": "end" }, axis).textContent = v;
  }
  for (let v = 0; v <= 40; v += 10) el("text", { x: x(v), y: h - m.b + 20, "text-anchor": "middle" }, axis).textContent = v;
  el("text", { class: "title", x: w - m.r, y: h - 10, "text-anchor": "end" }, axis).textContent = "Air temperature (°C)";
  const cy = m.t + (h - m.t - m.b) / 2;
  el("text", { class: "title", x: 14, y: cy, "text-anchor": "middle", transform: `rotate(-90 14 ${cy})` }, axis).textContent = "Net output (MW)";
  el("g", { id: "live" }, overlay);
}

function drawLive(animate) {
  const live = overlay.querySelector("#live");
  if (!live || !state.result || state.sweep < 1) return;
  live.replaceChildren();
  const { x, y, w } = geom;
  const px = x(Math.min(X_DOMAIN[1], state.inputs[0]));
  const py = y(state.result.value);
  const lines = state.result.rows.map((n) => el("line", { class: "link", x1: px, y1: py, x2: x(n.inputs[0]), y2: y(n.output) }, live));
  // a dark under-ring keeps the neighbours visible on the bright centre of the cloud
  state.result.rows.forEach((n) => el("circle", { class: "ring-under", cx: x(n.inputs[0]), cy: y(n.output), r: 6 }, live));
  const rings = state.result.rows.map((n) => el("circle", { class: "ring", cx: x(n.inputs[0]), cy: y(n.output), r: 6 }, live));
  const halo = el("circle", { class: "marker-halo", cx: px, cy: py, r: 18 }, live);
  el("circle", { class: "marker", cx: px, cy: py, r: 8 }, live);
  const right = px < w * 0.7;
  el("text", { class: "marker-label", x: px + (right ? 16 : -16), y: py - 14, "text-anchor": right ? "start" : "end" }, live).textContent = `${fmt(state.result.value)} MW`;
  if (gsap) {
    gsap.fromTo(halo, { attr: { r: 8 }, opacity: 0.5 }, { attr: { r: 26 }, opacity: 0, duration: 1.8, repeat: -1, ease: "power2.out" });
    if (animate) {
      lines.forEach((l) => { const len = Math.hypot(l.x2.baseVal.value - px, l.y2.baseVal.value - py); l.style.strokeDasharray = len; l.style.strokeDashoffset = len; });
      gsap.to(lines, { strokeDashoffset: 0, duration: 0.55, ease: "power2.out", stagger: 0.04 });
      gsap.from(rings, { attr: { r: 0 }, duration: 0.45, ease: "back.out(2)", stagger: 0.04, delay: 0.15 });
    }
  }
}

// ---------- readout
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
  if (check.level === "caution") return "Few similar past hours. Treat with caution.";
  return "Inside the recorded data. Similar past hours exist.";
}

let tween = null;
function showValue(v) {
  if (!gsap) { $("mw").textContent = fmt(v); state.shown = v; return; }
  if (tween) tween.kill();
  const o = { v: state.shown || v };
  tween = gsap.to(o, { v, duration: 0.5, ease: "power3.out", onUpdate: () => { $("mw").textContent = fmt(o.v); state.shown = o.v; } });
}

let renderPending = false;
function render(animate = true) {
  const r = model.predict(state.inputs);
  state.result = r;
  const check = checkInput(data, state.inputs, r.meanDistance);
  document.documentElement.style.setProperty("--heat", heatColor(state.inputs[0]));
  showValue(r.value);
  $("band").textContent = check.level === "flagged"
    ? "No error band: the model has never seen these conditions."
    : `Likely range ${fmt(r.value - data.band.below)} to ${fmt(r.value + data.band.above)} MW. Actual output landed in a band this wide on 90% of test hours.`;
  const status = $("status");
  status.dataset.level = check.level;
  status.textContent = statusText(check);
  FIELDS.forEach((f, j) => {
    const input = $(f.id);
    const v = state.inputs[j];
    const out = $(`${f.id}-out`);
    out.textContent = `${fmt(v)} ${f.unit}`;
    out.classList.toggle("outside", check.outside.includes(f.id));
    input.style.setProperty("--fill", `${((v - input.min) / (input.max - input.min)) * 100}%`);
  });
  $("nb-rows").replaceChildren(...r.rows.map((n) => {
    const tr = document.createElement("tr");
    [`#${n.id}`, ...n.inputs.map((v) => fmt(v, 2)), fmt(n.output, 2)].forEach((c, k) => {
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
  drawLive(animate);
  renderAlarm(false);
  renderCommit();
}
// slider drags fire many events; draw once per frame
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(false); });
}

// ---------- decision tools
function renderAlarm(bump = true) {
  const box = $("alarm");
  const raw = $("measured").value.trim();
  $("alarm-rule").textContent = `The alarm sounds when output is more than ${fmt(data.alarm)} MW below the prediction. Healthy hours stay above that on 95% of test hours.`;
  const before = box.dataset.state;
  if (raw === "" || !Number.isFinite(Number(raw))) {
    box.dataset.state = "";
    box.textContent = "Enter a measured output to compare it with the prediction.";
  } else {
    const gap = state.result.value - Number(raw);
    if (gap > data.alarm) {
      box.dataset.state = "alarm";
      box.textContent = `Alarm: ${fmt(gap)} MW below what these conditions allow. Check the compressor, the condenser and recent trips.`;
    } else {
      box.dataset.state = "normal";
      box.textContent = gap >= 0 ? `Normal: ${fmt(gap)} MW below the prediction, inside the usual range.` : `Normal: ${fmt(-gap)} MW above the prediction.`;
    }
  }
  if (bump && box.dataset.state !== before && !REDUCED) { box.classList.remove("bump"); void box.offsetWidth; box.classList.add("bump"); }
}

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
  const W = Math.max(300, Math.min(460, $(target).clientWidth || 420)), rowH = 40, labelW = 128, H = rows.length * rowH;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": rows.map((r) => `${r[0]} ${fmt(r[1], digits)}${unit}`).join(", ") });
  const defs = el("defs", {}, svg);
  const g = el("linearGradient", { id: `${target}-g`, x1: 0, x2: 1 }, defs);
  el("stop", { offset: 0, "stop-color": "#5AB4E6" }, g);
  el("stop", { offset: 1, "stop-color": "#F2A33A" }, g);
  const rects = [];
  rows.forEach(([name, v, kind], i) => {
    const yy = i * rowH;
    el("text", { class: "name", x: 0, y: yy + 25 }, svg).textContent = name;
    const bw = (v / max) * (W - labelW - 74);
    rects.push(el("rect", { x: labelW, y: yy + 12, width: bw, height: 16, rx: 8, fill: kind === "best" ? `url(#${target}-g)` : kind === "base" ? "rgba(205,225,240,0.14)" : "rgba(205,225,240,0.32)" }, svg));
    el("text", { class: "val", x: labelW + bw + 10, y: yy + 25 }, svg).textContent = `${fmt(v, digits)}${unit}`;
  });
  $(target).appendChild(svg);
  if (gsap && window.ScrollTrigger) {
    gsap.from(rects, { attr: { width: 0 }, duration: 1.1, ease: "expo.out", stagger: 0.08, scrollTrigger: { trigger: svg, start: "top 85%" } });
  }
}

function rmseChart() {
  bars("rmse-chart", [
    ["KNN (chosen)", data.testMetrics.KNN["RMSE (MW)"], "best"],
    ["SVR", data.testMetrics.SVR["RMSE (MW)"], ""],
    ["Neural network", data.testMetrics.MLP["RMSE (MW)"], ""],
    ["Guess the average", data.testMetrics["Mean baseline"]["RMSE (MW)"], "base"],
  ], 18, " MW", 2);
  // share of test hours predicted more than 5 MW too high (report table 6)
  bars("over-chart", [["KNN (chosen)", 5.30, "best"], ["SVR", 6.87, ""], ["Neural network", 7.76, ""]], 9, "%", 1);
}

function heatChart() {
  const ex = data.extrapolation;
  const W = Math.max(300, Math.min(480, $("heat-chart").clientWidth || 440)), H = 300, m = { l: 40, r: 124, t: 12, b: 34 };
  const xs = [ex.AT[0], ex.AT[ex.AT.length - 1]];
  const all = [...ex.KNN, ...ex.SVR, ...ex.MLP];
  const ys = [Math.floor(Math.min(...all) / 5) * 5, Math.ceil(Math.max(...all) / 5) * 5];
  const x = (v) => m.l + ((v - xs[0]) / (xs[1] - xs[0])) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((v - ys[0]) / (ys[1] - ys[0])) * (H - m.t - m.b);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Predicted output from 28 to 45 °C. KNN stays flat near 430 MW, the neural network keeps falling to 419 MW, the SVR rises to 455 MW at 45 °C." });
  el("rect", { x: x(data.observedMaxAT), y: m.t, width: x(xs[1]) - x(data.observedMaxAT), height: H - m.t - m.b, fill: "rgba(255,107,91,0.06)", stroke: "rgba(255,107,91,0.18)" }, svg);
  el("text", { x: x(data.observedMaxAT) + 8, y: m.t + 16 }, svg).textContent = "No recorded hours";
  for (let v = ys[0]; v <= ys[1]; v += 10) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: "rgba(205,225,240,0.10)", "stroke-dasharray": "2 5" }, svg);
    el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = v;
  }
  for (let v = 30; v <= 45; v += 5) el("text", { x: x(v), y: H - m.b + 20, "text-anchor": "middle" }, svg).textContent = `${v} °C`;
  const lines = [["SVR", "#FF6B5B", "SVR"], ["KNN", "#E8EEF2", "KNN"], ["MLP", "#5AB4E6", "Neural network"]];
  const ends = lines.map(([k]) => y(ex[k][ex[k].length - 1]));
  const order = ends.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < order.length; k++) if (order[k][0] - order[k - 1][0] < 18) order[k][0] = order[k - 1][0] + 18;
  const labelY = []; order.forEach(([v, i]) => { labelY[i] = v; });
  const paths = [];
  lines.forEach(([k, c, name], i) => {
    const d = ex.AT.map((a, j) => `${j ? "L" : "M"}${x(a).toFixed(1)},${y(ex[k][j]).toFixed(1)}`).join("");
    paths.push(el("path", { d, fill: "none", stroke: c, "stroke-width": k === "KNN" ? 2.5 : 2.2, "stroke-linecap": "round" }, svg));
    const t = el("text", { class: "name", x: W - m.r + 10, y: labelY[i] + 4 }, svg);
    t.style.fill = c;
    t.textContent = `${name} ${fmt(ex[k][ex[k].length - 1], 0)}`;
  });
  $("heat-chart").appendChild(svg);
  if (gsap && window.ScrollTrigger) {
    paths.forEach((p) => { const len = p.getTotalLength(); p.style.strokeDasharray = len; p.style.strokeDashoffset = len; });
    gsap.to(paths, { strokeDashoffset: 0, duration: 1.8, ease: "power2.inOut", stagger: 0.15, scrollTrigger: { trigger: svg, start: "top 80%" } });
  }
}

// ---------- page choreography
function splitHeadline(h) {
  const text = h.textContent;
  h.setAttribute("aria-label", text);
  h.textContent = "";
  text.split(" ").forEach((word, i, arr) => {
    const w = document.createElement("span");
    w.className = "word";
    w.setAttribute("aria-hidden", "true");
    for (const ch of word) {
      const c = document.createElement("span");
      c.className = "char";
      c.textContent = ch;
      w.appendChild(c);
    }
    h.appendChild(w);
    if (i < arr.length - 1) h.appendChild(document.createTextNode(" "));
  });
  return h.querySelectorAll(".char");
}

function choreograph() {
  if (!gsap) return;
  const ST = window.ScrollTrigger;
  const chars = splitHeadline(document.querySelector(".split"));
  const intro = gsap.timeline({ defaults: { ease: "expo.out" } });
  intro.from(chars, { yPercent: 110, opacity: 0, rotateX: -60, duration: 1.1, stagger: 0.018 })
    .from(".hero .reveal", { y: 24, opacity: 0, duration: 1, stagger: 0.1 }, "-=0.7")
    .from(".nav", { y: -20, opacity: 0, duration: 0.8 }, "<");

  document.querySelectorAll(".count").forEach((n) => {
    const to = Number(n.dataset.to), dec = Number(n.dataset.dec);
    const o = { v: 0 };
    gsap.to(o, { v: to, duration: 2, ease: "power3.out", delay: 0.9, onUpdate: () => { n.textContent = fmt(o.v, dec); } });
  });

  if (!ST) return;
  ST.batch("main > section:not(.hero) .reveal", {
    start: "top 88%",
    onEnter: (els) => gsap.fromTo(els, { y: 36, opacity: 0 }, { y: 0, opacity: 1, duration: 1, ease: "power3.out", stagger: 0.09, overwrite: true }),
  });
  gsap.set("main > section:not(.hero) .reveal", { opacity: 0 });

  // the cloud of hours sweeps in from cold to hot
  ST.create({
    trigger: "#plot", start: "top 75%", once: true,
    onEnter: () => gsap.to(state, { sweep: 1, duration: 1.6, ease: "power2.inOut", onUpdate: drawCloud, onComplete: () => drawLive(true) }),
  });
  // the timeline line fills as you scroll through the method
  ST.create({ trigger: "#timeline", start: "top 75%", end: "bottom 55%", scrub: 0.6, onUpdate: (s) => $("timeline").style.setProperty("--progress", s.progress) });
}

// ---------- wiring
function syncPresets() {
  const now = state.inputs.join(",");
  document.querySelectorAll("[data-case]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.case.split(",").map(Number).join(",") === now ? "true" : "false"));
}
FIELDS.forEach((f, j) => $(f.id).addEventListener("input", (e) => { state.inputs[j] = Number(e.target.value); syncPresets(); scheduleRender(); }));
document.querySelectorAll("[data-case]").forEach((b) => b.addEventListener("click", () => {
  const v = b.dataset.case.split(",").map(Number);
  FIELDS.forEach((f, j) => { $(f.id).value = v[j]; });
  state.inputs = v;
  syncPresets();
  render(true);
}));
$("measured").addEventListener("input", () => renderAlarm(true));
$("ratio").addEventListener("input", renderCommit);
$("controls").addEventListener("submit", (e) => e.preventDefault());

let scrollPending = false;
window.addEventListener("scroll", () => {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    $("nav").classList.toggle("scrolled", window.scrollY > 24);
    updateStory();
    if (!gsap || !window.ScrollTrigger) {
      const t = $("timeline").getBoundingClientRect();
      $("timeline").style.setProperty("--progress", clamp((window.innerHeight * 0.75 - t.top) / (t.height + window.innerHeight * 0.2), 0, 1));
    }
  });
}, { passive: true });

function redraw() { layout(); drawCloud(); drawAxes(); drawLive(false); }
new ResizeObserver(redraw).observe(frame);

redraw();
render(false);
syncPresets();
rmseChart();
heatChart();
updateStory();
$("nav").classList.toggle("scrolled", window.scrollY > 24);
choreograph();
