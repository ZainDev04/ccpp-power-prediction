// The selected model: k-nearest neighbours regression with k = 6, inverse-distance weights and
// Manhattan distance on standardized inputs. Same rules as scikit-learn's KNeighborsRegressor.
export const K = 6;

export function makeModel(data) {
  const { mean, scale } = data.scaler;
  const n = data.train.length;
  const width = mean.length;
  // standardized training inputs in one flat array, for a fast scan
  const xs = new Float64Array(n * width);
  data.train.forEach((row, i) => {
    for (let j = 0; j < width; j++) xs[i * width + j] = (row[j] - mean[j]) / scale[j];
  });

  function neighbours(input) {
    const q = input.map((v, j) => (v - mean[j]) / scale[j]);
    // keep the K closest rows in a small sorted list
    const best = [];
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let j = 0; j < width; j++) d += Math.abs(xs[i * width + j] - q[j]);
      if (best.length < K || d < best[best.length - 1].d) {
        let at = best.length;
        while (at > 0 && best[at - 1].d > d) at--;
        best.splice(at, 0, { i, d });
        if (best.length > K) best.pop();
      }
    }
    return best;
  }

  function predict(input) {
    const nb = neighbours(input);
    // an exact match takes all the weight, as in scikit-learn
    const exact = nb.filter((b) => b.d === 0);
    const used = exact.length ? exact : nb;
    const weights = used.map((b) => (exact.length ? 1 : 1 / b.d));
    const total = weights.reduce((a, b) => a + b, 0);
    const value = used.reduce((a, b, k) => a + weights[k] * data.train[b.i][width], 0) / total;
    const rows = nb.map((b) => {
      const w = exact.length ? (b.d === 0 ? 1 / exact.length : 0) : 1 / b.d / total;
      const r = data.train[b.i];
      return { id: r[width + 1], inputs: r.slice(0, width), output: r[width], distance: b.d, weight: w };
    });
    const meanDistance = nb.reduce((a, b) => a + b.d, 0) / nb.length;
    return { value, rows, meanDistance };
  }

  return { predict };
}

// Reliability checks used by the deployed model (report section 10)
export function checkInput(data, input, meanDistance) {
  const outside = data.features.filter((f, j) => input[j] < data.envelope[f][0] || input[j] > data.envelope[f][1]);
  if (outside.length) return { level: "flagged", outside };
  if (meanDistance > data.densityLimit) return { level: "caution", outside };
  return { level: "valid", outside };
}
