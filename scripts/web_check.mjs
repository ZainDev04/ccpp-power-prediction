// Checks the browser KNN against the Python predictions on all 1,906 test hours
import fs from "fs";
import { makeModel } from "../web/knn.js";
const data = JSON.parse(fs.readFileSync(new URL("../web/data/model.json", import.meta.url)));
const fx = JSON.parse(fs.readFileSync(new URL("./web_fixture.json", import.meta.url)));
const m = makeModel(data);
let worst = 0, worstD = 0;
const t0 = Date.now();
fx.X.forEach((x, i) => {
  const r = m.predict(x);
  worst = Math.max(worst, Math.abs(r.value - fx.pred[i]));
  worstD = Math.max(worstD, Math.abs(r.meanDistance - fx.dist[i]));
});
console.log(`hours ${fx.X.length}, largest prediction gap ${worst.toExponential(2)} MW, largest distance gap ${worstD.toExponential(2)}, ${((Date.now() - t0) / fx.X.length).toFixed(2)} ms per prediction`);
const cases = [[33,71,1008,45],[6,40,1020,85],[20,52,1013,90],[20,52,1013,45],[41,74,1006,30]];
cases.forEach((c) => console.log(c.join(","), m.predict(c).value.toFixed(1), m.predict(c).meanDistance.toFixed(3)));
