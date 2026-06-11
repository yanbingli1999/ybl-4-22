const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const math = require('mathjs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DATASETS_FILE = path.join(DATA_DIR, 'datasets.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATASETS_FILE)) {
    fs.writeFileSync(DATASETS_FILE, JSON.stringify([], null, 2));
  }
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
  }
}
ensureDataFiles();

function readJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return [];
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function linearRegression(points) {
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  points.forEach(p => {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  });
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { a: slope, b: intercept };
}

function exponentialRegression(points) {
  const invalidPoints = points.filter(p => p.y <= 0);
  if (invalidPoints.length > 0) {
    const indices = invalidPoints.map((_, i) => {
      const idx = points.indexOf(invalidPoints[i]) + 1;
      return `#${idx}(y=${invalidPoints[i].y})`;
    }).join(', ');
    throw new Error(`指数拟合要求所有Y值必须大于0，存在非法点: ${indices}`);
  }
  const n = points.length;
  const logPoints = points.map(p => ({ x: p.x, y: Math.log(p.y) }));
  const linearResult = linearRegression(logPoints);
  return { a: Math.exp(linearResult.b), b: linearResult.a };
}

function quadraticRegression(points) {
  const n = points.length;
  const rows = points.map(p => [p.x * p.x, p.x, 1]);
  const A = math.matrix(rows);
  const b = math.matrix(points.map(p => p.y));
  const AT = math.transpose(A);
  const ATA = math.multiply(AT, A);
  const ATb = math.multiply(AT, b);
  try {
    const ATAInv = math.inv(ATA);
    const x = math.multiply(ATAInv, ATb);
    const result = x.toArray();
    return { a: result[0], b: result[1], c: result[2] };
  } catch (e) {
    return { a: 0, b: 0, c: 0 };
  }
}

function calculateMetrics(points, modelType, params, customFormula = null) {
  const n = points.length;
  let yMean = 0;
  points.forEach(p => yMean += p.y);
  yMean /= n;

  let ssTotal = 0;
  let ssResidual = 0;
  const residuals = [];
  let maeSum = 0;
  let rmseSum = 0;

  points.forEach(p => {
    let predicted;
    if (modelType === 'custom' && customFormula) {
      const scope = { x: p.x, ...params };
      predicted = math.evaluate(customFormula, scope);
    } else {
      switch (modelType) {
        case 'linear':
          predicted = params.a * p.x + params.b;
          break;
        case 'exponential':
          predicted = params.a * Math.exp(params.b * p.x);
          break;
        case 'quadratic':
          predicted = params.a * p.x * p.x + params.b * p.x + params.c;
          break;
      }
    }
    const residual = p.y - predicted;
    residuals.push(residual);
    ssResidual += residual * residual;
    ssTotal += (p.y - yMean) * (p.y - yMean);
    maeSum += Math.abs(residual);
    rmseSum += residual * residual;
  });

  const rSquared = 1 - (ssResidual / ssTotal);
  const mse = ssResidual / n;
  const rmse = Math.sqrt(rmseSum / n);
  const mae = maeSum / n;

  const residualStd = math.std(residuals);

  const outliers = residuals.map((r, i) => {
    const zScore = Math.abs(r - math.mean(residuals)) / residualStd;
    return { index: i, isOutlier: zScore > 2, zScore: zScore, residual: r };
  });

  return { rSquared, mse, rmse, mae, residuals, outliers };
}

function generateCurvePoints(points, modelType, params, numPoints = 100, customFormula = null) {
  const xs = points.map(p => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const range = maxX - minX || 1;
  const extendedMin = minX - range * 0.1;
  const extendedMax = maxX + range * 0.1;
  const step = (extendedMax - extendedMin) / (numPoints - 1);
  const curvePoints = [];
  for (let i = 0; i < numPoints; i++) {
    const x = extendedMin + i * step;
    let y;
    if (modelType === 'custom' && customFormula) {
      const scope = { x, ...params };
      y = math.evaluate(customFormula, scope);
    } else {
      switch (modelType) {
        case 'linear':
          y = params.a * x + params.b;
          break;
        case 'exponential':
          y = params.a * Math.exp(params.b * x);
          break;
        case 'quadratic':
          y = params.a * x * x + params.b * x + params.c;
          break;
      }
    }
    curvePoints.push({ x, y });
  }
  return curvePoints;
}

function validateCustomFormula(formula, paramNames) {
  try {
    const testScope = { x: 1 };
    paramNames.forEach(name => {
      testScope[name] = 1;
    });
    const result = math.evaluate(formula, testScope);
    if (typeof result !== 'number' || !isFinite(result)) {
      return { valid: false, error: '公式计算结果不是有限数值' };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

function levenbergMarquardt(points, formula, paramConfigs, options = {}) {
  const {
    maxIterations = 200,
    tolerance = 1e-10,
    initialLambda = 1e-3,
    lambdaUp = 10,
    lambdaDown = 10
  } = options;

  const paramNames = paramConfigs.map(p => p.name);
  const nParams = paramNames.length;
  const nPoints = points.length;

  let params = paramConfigs.map(p => p.initial);
  let lambda = initialLambda;

  const clampParams = (vals) => {
    return vals.map((v, i) => {
      const cfg = paramConfigs[i];
      let val = v;
      if (cfg.lowerBound !== undefined && val < cfg.lowerBound) val = cfg.lowerBound;
      if (cfg.upperBound !== undefined && val > cfg.upperBound) val = cfg.upperBound;
      return val;
    });
  };

  const evaluateModel = (x, paramVals) => {
    const scope = { x };
    paramNames.forEach((name, i) => {
      scope[name] = paramVals[i];
    });
    return math.evaluate(formula, scope);
  };

  const computeResiduals = (paramVals) => {
    const residuals = [];
    for (let i = 0; i < nPoints; i++) {
      const yPred = evaluateModel(points[i].x, paramVals);
      residuals.push(points[i].y - yPred);
    }
    return residuals;
  };

  const computeCost = (residuals) => {
    let sum = 0;
    for (let i = 0; i < residuals.length; i++) {
      sum += residuals[i] * residuals[i];
    }
    return sum;
  };

  const computeJacobian = (paramVals, eps = 1e-8) => {
    const J = [];
    for (let i = 0; i < nPoints; i++) {
      const row = [];
      const x = points[i].x;
      const yBase = evaluateModel(x, paramVals);
      for (let j = 0; j < nParams; j++) {
        const perturbed = [...paramVals];
        const step = Math.max(Math.abs(paramVals[j]) * eps, eps);
        perturbed[j] += step;
        const yPerturbed = evaluateModel(x, perturbed);
        row.push((yPerturbed - yBase) / step);
      }
      J.push(row);
    }
    return J;
  };

  const multiplyJtJ = (J) => {
    const result = [];
    for (let i = 0; i < nParams; i++) {
      result[i] = [];
      for (let j = 0; j < nParams; j++) {
        let sum = 0;
        for (let k = 0; k < nPoints; k++) {
          sum += J[k][i] * J[k][j];
        }
        result[i][j] = sum;
      }
    }
    return result;
  };

  const multiplyJtR = (J, residuals) => {
    const result = [];
    for (let i = 0; i < nParams; i++) {
      let sum = 0;
      for (let k = 0; k < nPoints; k++) {
        sum += J[k][i] * residuals[k];
      }
      result[i] = sum;
    }
    return result;
  };

  const solveLinearSystem = (A, b) => {
    const n = A.length;
    const aug = A.map((row, i) => [...row, b[i]]);

    for (let i = 0; i < n; i++) {
      let maxRow = i;
      let maxVal = Math.abs(aug[i][i]);
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(aug[k][i]) > maxVal) {
          maxVal = Math.abs(aug[k][i]);
          maxRow = k;
        }
      }
      [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];

      const pivot = aug[i][i];
      if (Math.abs(pivot) < 1e-15) return null;

      for (let j = i; j <= n; j++) {
        aug[i][j] /= pivot;
      }

      for (let k = 0; k < n; k++) {
        if (k !== i) {
          const factor = aug[k][i];
          for (let j = i; j <= n; j++) {
            aug[k][j] -= factor * aug[i][j];
          }
        }
      }
    }

    return aug.map(row => row[n]);
  };

  let residuals = computeResiduals(params);
  let cost = computeCost(residuals);
  let iterations = 0;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    const J = computeJacobian(params);
    const JtJ = multiplyJtJ(J);
    const JtR = multiplyJtR(J, residuals);

    let delta = null;
    let attempts = 0;
    while (delta === null && attempts < 20) {
      const A = JtJ.map((row, i) => {
        const r = [...row];
        r[i] += lambda * (row[i] + 1e-10);
        return r;
      });

      delta = solveLinearSystem(A, JtR);
      if (delta === null) {
        lambda *= lambdaUp;
        attempts++;
      }
    }

    if (delta === null) break;

    const newParams = clampParams(params.map((p, i) => p + delta[i]));
    const newResiduals = computeResiduals(newParams);
    const newCost = computeCost(newResiduals);

    if (newCost < cost) {
      const costReduction = (cost - newCost) / cost;
      params = newParams;
      residuals = newResiduals;
      cost = newCost;
      lambda /= lambdaDown;

      if (costReduction < tolerance || cost < tolerance) {
        converged = true;
        break;
      }
    } else {
      lambda *= lambdaUp;
      if (lambda > 1e15) break;
    }
  }

  const paramObject = {};
  paramNames.forEach((name, i) => {
    paramObject[name] = params[i];
  });

  return {
    params: paramObject,
    cost,
    iterations,
    converged
  };
}

app.get('/api/datasets', (req, res) => {
  const datasets = readJsonFile(DATASETS_FILE);
  res.json(datasets);
});

app.post('/api/datasets', (req, res) => {
  const { name, points } = req.body;
  if (!name || !points || !Array.isArray(points)) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  const datasets = readJsonFile(DATASETS_FILE);
  const dataset = {
    id: generateId(),
    name,
    points,
    createdAt: new Date().toISOString()
  };
  datasets.push(dataset);
  writeJsonFile(DATASETS_FILE, datasets);
  res.json(dataset);
});

app.put('/api/datasets/:id', (req, res) => {
  const { id } = req.params;
  const { name, points } = req.body;
  const datasets = readJsonFile(DATASETS_FILE);
  const index = datasets.findIndex(d => d.id === id);
  if (index === -1) {
    return res.status(404).json({ error: '数据集不存在' });
  }
  datasets[index].name = name || datasets[index].name;
  datasets[index].points = points || datasets[index].points;
  datasets[index].updatedAt = new Date().toISOString();
  writeJsonFile(DATASETS_FILE, datasets);
  res.json(datasets[index]);
});

app.delete('/api/datasets/:id', (req, res) => {
  const { id } = req.params;
  let datasets = readJsonFile(DATASETS_FILE);
  const initialLength = datasets.length;
  datasets = datasets.filter(d => d.id !== id);
  if (datasets.length === initialLength) {
    return res.status(404).json({ error: '数据集不存在' });
  }
  writeJsonFile(DATASETS_FILE, datasets);
  res.json({ success: true });
});

app.post('/api/fit', (req, res) => {
  const { datasetId, points, modelType, datasetName, customFormula, paramConfigs } = req.body;
  if (!points || !Array.isArray(points) || points.length < 2) {
    return res.status(400).json({ error: '至少需要2个数据点' });
  }
  if (!modelType) {
    return res.status(400).json({ error: '请选择拟合模型' });
  }

  let params;
  let modelEquation;
  let customInfo = null;

  try {
    switch (modelType) {
      case 'linear':
        params = linearRegression(points);
        modelEquation = `y = ${params.a.toFixed(6)}x + ${params.b.toFixed(6)}`;
        break;
      case 'exponential':
        params = exponentialRegression(points);
        modelEquation = `y = ${params.a.toFixed(6)} · e^(${params.b.toFixed(6)}x)`;
        break;
      case 'quadratic':
        params = quadraticRegression(points);
        modelEquation = `y = ${params.a.toFixed(6)}x² + ${params.b.toFixed(6)}x + ${params.c.toFixed(6)}`;
        break;
      case 'custom':
        if (!customFormula) {
          return res.status(400).json({ error: '请输入自定义公式' });
        }
        if (!paramConfigs || !Array.isArray(paramConfigs) || paramConfigs.length === 0) {
          return res.status(400).json({ error: '请至少设置一个参数' });
        }
        const paramNames = paramConfigs.map(p => p.name);
        const validation = validateCustomFormula(customFormula, paramNames);
        if (!validation.valid) {
          return res.status(400).json({ error: '公式解析错误: ' + validation.error });
        }
        const lmResult = levenbergMarquardt(points, customFormula, paramConfigs);
        params = lmResult.params;
        modelEquation = `y = ${customFormula}`;
        customInfo = {
          formula: customFormula,
          paramConfigs,
          iterations: lmResult.iterations,
          converged: lmResult.converged,
          finalCost: lmResult.cost
        };
        break;
      default:
        return res.status(400).json({ error: '不支持的模型类型' });
    }
  } catch (e) {
    return res.status(400).json({ error: '拟合计算失败: ' + e.message });
  }

  const metrics = calculateMetrics(points, modelType, params, customFormula);
  const curvePoints = generateCurvePoints(points, modelType, params, 100, customFormula);

  const result = {
    id: generateId(),
    datasetId: datasetId || null,
    datasetName: datasetName || '未命名数据集',
    modelType,
    params,
    modelEquation,
    customInfo,
    metrics: {
      rSquared: metrics.rSquared,
      mse: metrics.mse,
      rmse: metrics.rmse,
      mae: metrics.mae
    },
    residuals: metrics.residuals,
    outliers: metrics.outliers,
    curvePoints,
    points,
    createdAt: new Date().toISOString()
  };

  const history = readJsonFile(HISTORY_FILE);
  history.unshift(result);
  if (history.length > 50) {
    history.length = 50;
  }
  writeJsonFile(HISTORY_FILE, history);

  res.json(result);
});

app.post('/api/validate-formula', (req, res) => {
  const { formula, paramConfigs } = req.body;
  if (!formula) {
    return res.status(400).json({ error: '请输入公式' });
  }
  const paramNames = (paramConfigs || []).map(p => p.name);
  const validation = validateCustomFormula(formula, paramNames);
  res.json(validation);
});

app.get('/api/history', (req, res) => {
  const history = readJsonFile(HISTORY_FILE);
  const summaries = history.map(h => ({
    id: h.id,
    datasetId: h.datasetId,
    datasetName: h.datasetName,
    modelType: h.modelType,
    modelEquation: h.modelEquation,
    metrics: h.metrics,
    pointsCount: h.points.length,
    createdAt: h.createdAt
  }));
  res.json(summaries);
});

app.get('/api/history/:id', (req, res) => {
  const { id } = req.params;
  const history = readJsonFile(HISTORY_FILE);
  const result = history.find(h => h.id === id);
  if (!result) {
    return res.status(404).json({ error: '记录不存在' });
  }
  res.json(result);
});

app.delete('/api/history/:id', (req, res) => {
  const { id } = req.params;
  let history = readJsonFile(HISTORY_FILE);
  const initialLength = history.length;
  history = history.filter(h => h.id !== id);
  if (history.length === initialLength) {
    return res.status(404).json({ error: '记录不存在' });
  }
  writeJsonFile(HISTORY_FILE, history);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`实验曲线拟合台 服务器已启动: http://localhost:${PORT}`);
});
