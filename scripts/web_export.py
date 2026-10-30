"""Exports the data the website needs into web/data/model.json.

Refits the tuned models on the same 7,621 training hours as the notebook and checks
that they reproduce the notebook's saved predictions before writing anything.
Run from the repository root: python -I scripts/web_export.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import TransformedTargetRegressor
from sklearn.model_selection import train_test_split
from sklearn.neighbors import KNeighborsRegressor
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVR

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "web" / "data" / "model.json"
NB_OUT = REPO / "02_Notebook" / "outputs"
FEATURES, TARGET = ["AT", "V", "AP", "RH"], "PE"

split = pd.read_csv(NB_OUT / "split_assignment.csv", index_col="raw_index")
# redo the notebook's split so the rows come in the same order (the MLP's early-stopping hold-out depends on it)
X_train, X_test, y_train, y_test = train_test_split(
    split[FEATURES], split[TARGET], test_size=0.20, random_state=42,
    stratify=pd.qcut(split[TARGET], q=10, labels=False))
assert set(X_test.index) == set(split.index[split["set"] == "test"]) and len(X_train) == 7621
train = X_train.join(y_train)


def pipe(est):
    return Pipeline([("scale", StandardScaler()), ("model", est)])


knn = pipe(KNeighborsRegressor(n_neighbors=6, weights="distance", p=1)).fit(X_train, y_train)
svr = pipe(SVR(kernel="rbf", C=30, gamma=2.0, epsilon=2.0)).fit(X_train, y_train)
mlp = pipe(TransformedTargetRegressor(
    regressor=MLPRegressor(hidden_layer_sizes=(128, 128, 64), alpha=1e-4, activation="relu", solver="adam",
                           learning_rate_init=1e-3, early_stopping=True, validation_fraction=0.1,
                           n_iter_no_change=30, max_iter=2000, random_state=42),
    transformer=StandardScaler())).fit(X_train, y_train)

# the refitted models must match the notebook's saved test predictions (stored to 2 decimals)
saved = pd.read_csv(NB_OUT / "test_predictions.csv", index_col="raw_index").loc[X_test.index]
for name, model in {"KNN": knn, "SVR": svr, "MLP": mlp}.items():
    gap = np.abs(model.predict(X_test) - saved[f"pred_{name}"]).max()
    print(f"{name}: largest difference from the notebook's test predictions {gap:.4f} MW")
    assert gap < 0.006, name

pred = knn.predict(X_test)
err = pred - y_test                                    # + = over-prediction
q05, q95 = err.quantile([0.05, 0.95])
scaler = knn.named_steps["scale"]
dist, _ = knn.named_steps["model"].kneighbors(scaler.transform(X_test))
density_limit = float(np.percentile(dist.mean(axis=1), 95))
print(f"band: -{q95:.3f} / +{-q05:.3f} MW, alarm {q95:.3f} MW, density limit {density_limit:.4f}")

# behaviour beyond the data, as in notebook section 10.6
clean = split[FEATURES + [TARGET]]
cold = clean[clean["AT"] <= clean["AT"].quantile(0.05)][FEATURES].mean()
hot = clean[clean["AT"] >= clean["AT"].quantile(0.95)][FEATURES].mean()
grid = pd.DataFrame({"AT": np.arange(28, 45.1, 0.5), "V": hot["V"], "AP": hot["AP"], "RH": hot["RH"]})
extrap = {"AT": grid["AT"].round(1).tolist()}
for name, model in {"KNN": knn, "SVR": svr, "MLP": mlp}.items():
    extrap[name] = model.predict(grid).round(2).tolist()
print("at 45 C:", {k: v[-1] for k, v in extrap.items() if k != "AT"})

metrics = pd.read_csv(REPO / "03_Dashboard" / "data" / "model_metrics.csv")
test_metrics = metrics[metrics["Evaluation"] == "test"].pivot(index="Model", columns="Metric", values="Value")

data = {
    "features": FEATURES,
    "scaler": {"mean": scaler.mean_.round(10).tolist(), "scale": scaler.scale_.round(10).tolist()},
    # training hours: AT, V, AP, RH, PE, hour id
    "train": [[*r[FEATURES].tolist(), r[TARGET], int(i)] for i, r in train.iterrows()],
    # every cleaned hour for the background chart: AT, PE
    "hours": clean[["AT", TARGET]].values.round(2).tolist(),
    "envelope": {f: [float(X_train[f].min()), float(X_train[f].max())] for f in FEATURES},
    "band": {"below": round(float(q95), 3), "above": round(float(-q05), 3)},
    "alarm": round(float(q95), 3),
    "densityLimit": round(density_limit, 4),
    "testErrors": np.sort(err.values).round(3).tolist(),
    "testMetrics": {m: {k: round(float(v), 4) for k, v in row.dropna().items()} for m, row in test_metrics.iterrows()},
    "extrapolation": extrap,
    "observedMaxAT": float(clean["AT"].max()),
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False), encoding="utf-8")
print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")

# fixture for checking the JavaScript KNN: test inputs and the Python predictions
fixture = {"X": X_test.values.tolist(), "pred": pred.tolist(), "dist": dist.mean(axis=1).tolist()}
(REPO / "scripts" / "web_fixture.json").write_text(json.dumps(fixture), encoding="utf-8")
