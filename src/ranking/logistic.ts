/**
 * Logistic regression, small and dependency-free: about 20 features and a few thousand
 * labeled links. Fitted with Newton's method (iteratively reweighted least squares), which
 * converges in a handful of steps and gives the same answer every run.
 */

export interface LogisticModel {
  bias: number;
  weights: number[];
}

export interface TrainOptions {
  /** L2 penalty on the weights (not the bias). Keeps weights small when a feature is rare. */
  l2?: number;
  maxIter?: number;
  /** Per-sample weights, e.g. to balance classes. Defaults to 1. */
  sampleWeight?: number[];
}

export const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export function logit(m: LogisticModel, x: number[]): number {
  let z = m.bias;
  for (let j = 0; j < x.length; j++) z += m.weights[j]! * x[j]!;
  return z;
}

export const predict = (m: LogisticModel, x: number[]) => sigmoid(logit(m, x));

/** Solves A x = b for a small dense symmetric positive definite A (Gaussian elimination with pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const pivot = M[c]![c]!;
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / pivot;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

/** Fits weights and bias to maximize the L2-penalized log-likelihood of labels y (0 or 1). */
export function trainLogistic(X: number[][], y: number[], opts: TrainOptions = {}): LogisticModel {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const l2 = opts.l2 ?? 1;
  const sw = opts.sampleWeight ?? new Array(n).fill(1);
  // Parameter vector: [bias, w_1 .. w_d].
  let theta = new Array(d + 1).fill(0);
  for (let iter = 0; iter < (opts.maxIter ?? 50); iter++) {
    const grad = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const xi = [1, ...X[i]!];
      let z = 0;
      for (let j = 0; j <= d; j++) z += theta[j] * xi[j]!;
      const p = sigmoid(z);
      const s = sw[i]!;
      const r = s * (p - y[i]!);
      const w = s * Math.max(p * (1 - p), 1e-9);
      for (let j = 0; j <= d; j++) {
        if (xi[j] === 0) continue;
        grad[j] += r * xi[j]!;
        for (let k = j; k <= d; k++) if (xi[k] !== 0) H[j]![k]! += w * xi[j]! * xi[k]!;
      }
    }
    for (let j = 0; j <= d; j++) for (let k = 0; k < j; k++) H[j]![k] = H[k]![j]!;
    for (let j = 1; j <= d; j++) {
      grad[j] += l2 * theta[j];
      H[j]![j]! += l2;
    }
    H[0]![0]! += 1e-6;
    const step = solve(H, grad);
    theta = theta.map((t, j) => t - step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { bias: theta[0]!, weights: theta.slice(1) };
}

/** Area under the ROC curve: the chance a random positive outscores a random negative (ties count half). */
export function auc(scores: number[], y: number[]): number {
  const idx = scores.map((s, i) => [s, y[i]!] as const).sort((a, b) => a[0] - b[0]);
  let pos = 0;
  let neg = 0;
  let rankSum = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j < idx.length && idx[j]![0] === idx[i]![0]) j++;
    const avgRank = (i + j + 1) / 2; // ranks i+1..j
    for (let k = i; k < j; k++) if (idx[k]![1] === 1) rankSum += avgRank;
    i = j;
  }
  for (const v of y) v === 1 ? pos++ : neg++;
  if (!pos || !neg) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}
