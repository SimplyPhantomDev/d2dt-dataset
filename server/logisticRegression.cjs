const sigmoid = z =>
    z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

const softplus = z =>
    Math.max(0, z) + Math.log1p(Math.exp(-Math.abs(z)));

const dot = (a, b) =>
    a.reduce((sum, value, index) => sum + value * b[index], 0);

const maxAbs = a =>
    a.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);

function score(model, values) {
    if (values.length !== model.coefficients.length) {
        throw new Error("Model feature count mismatch.");
    }

    return model.intercept + dot(model.coefficients, values);
}

function predictRadiant(model, values) {
    return sigmoid(score(model, values));
}

function fitLogistic(rows, columns, lambda) {
    const width = Array.isArray(rows) ? rows[0]?.values?.length : undefined;

    if (!Number.isSafeInteger(width) || width < 1 || !rows.length
        || !Number.isFinite(lambda) || lambda <= 0
        || !Array.isArray(columns) || !columns.length
        || new Set(columns).size !== columns.length
        || ![...columns].every(index =>
            Number.isSafeInteger(index) && index >= 0 && index < width)
        || rows.some(row =>
            (row.target !== 0 && row.target !== 1)
            || !Array.isArray(row.values)
            || row.values.length !== width
            || !row.values.every(Number.isFinite))
        || new Set(rows.map(row => row.target)).size !== 2) {
        throw new Error(
            "Logistic fitting requires valid features, both outcomes and positive regularization."
        );
    }

    // Sparse copies avoid multiplying the many zero-valued draft features.
    const points = rows.map(row => {
        const indices = [0];
        const values = [1];

        columns.forEach((column, index) => {
            if (row.values[column] !== 0) {
                indices.push(index + 1);
                values.push(row.values[column]);
            }
        });

        return { indices, values, target: row.target };
    });

    function objective(weights) {
        const gradient = new Float64Array(weights.length);
        let loss = 0;

        for (const point of points) {
            let z = 0;

            for (let k = 0; k < point.indices.length; k++) {
                z += weights[point.indices[k]] * point.values[k];
            }

            loss += softplus(point.target ? -z : z);
            const residual = sigmoid(z) - point.target;

            for (let k = 0; k < point.indices.length; k++) {
                gradient[point.indices[k]] += residual * point.values[k];
            }
        }

        loss /= rows.length;

        for (let j = 0; j < weights.length; j++) {
            gradient[j] /= rows.length;

            // Mean log loss + lambda/2 * squared coefficients.
            // The intercept is unpenalized.
            if (j > 0) {
                loss += lambda * weights[j] ** 2 / 2;
                gradient[j] += lambda * weights[j];
            }
        }

        return { loss, gradient };
    }

    const prior = rows.reduce((sum, row) => sum + row.target, 0) / rows.length;
    let weights = new Float64Array(columns.length + 1);
    weights[0] = Math.log(prior / (1 - prior));

    let current = objective(weights);
    const history = [];

    for (let iteration = 0; iteration <= 400; iteration++) {
        const gradientMaximum = maxAbs(current.gradient);

        if (gradientMaximum <= 1e-6) {
            const coefficients = Array(width).fill(0);

            columns.forEach((column, index) => {
                coefficients[column] = weights[index + 1];
            });

            return {
                intercept: weights[0],
                coefficients,
                lambda,
                iterations: iteration,
                maxAbsGradient: gradientMaximum,
            };
        }

        if (iteration === 400) break;

        // L-BFGS approximates inverse curvature using ten recent updates.
        const q = Float64Array.from(current.gradient);
        const alpha = [];

        for (let i = history.length - 1; i >= 0; i--) {
            const h = history[i];
            alpha[i] = dot(h.s, q) / h.sy;

            for (let j = 0; j < q.length; j++) {
                q[j] -= alpha[i] * h.y[j];
            }
        }

        const last = history.at(-1);
        const scale = last ? last.sy / dot(last.y, last.y) : 1;
        const direction = Float64Array.from(q, value => value * scale);

        for (let i = 0; i < history.length; i++) {
            const h = history[i];
            const beta = dot(h.y, direction) / h.sy;

            for (let j = 0; j < direction.length; j++) {
                direction[j] += h.s[j] * (alpha[i] - beta);
            }
        }

        for (let j = 0; j < direction.length; j++) {
            direction[j] *= -1;
        }

        let slope = dot(current.gradient, direction);

        if (!Number.isFinite(slope) || slope >= 0) {
            history.length = 0;

            for (let j = 0; j < direction.length; j++) {
                direction[j] = -current.gradient[j];
            }

            slope = -dot(current.gradient, current.gradient);
        }

        // Backtracking requires a sufficient decrease in the training objective.
        let next, candidate;
        let step = 1;

        for (let attempt = 0; attempt < 40; attempt++, step *= 0.5) {
            candidate = Float64Array.from(
                weights,
                (value, j) => value + step * direction[j]
            );

            next = objective(candidate);

            if (Number.isFinite(next.loss)
                && next.loss <= current.loss + 1e-4 * step * slope) {
                break;
            }

            next = null;
        }

        if (!next) {
            throw new Error(`Logistic line search failed (lambda=${lambda}).`);
        }

        const s = Float64Array.from(
            candidate,
            (value, j) => value - weights[j]
        );

        const y = Float64Array.from(
            next.gradient,
            (value, j) => value - current.gradient[j]
        );

        const sy = dot(s, y);

        if (sy > 1e-14) {
            history.push({ s, y, sy });
            if (history.length > 10) history.shift();
        }

        weights = candidate;
        current = next;
    }

    throw new Error(`Logistic fitting did not converge (lambda=${lambda}).`);
}

function evaluateLogistic(model, rows) {
    if (!rows.length) {
        throw new Error("Evaluation requires at least one match.");
    }

    let loss = 0;
    let brier = 0;
    let correct = 0;
    let predicted = 0;

    for (const row of rows) {
        const z = score(model, row.values);
        const p = sigmoid(z);

        loss += softplus(row.target ? -z : z);
        brier += (p - row.target) ** 2;
        correct += Number(Number(p >= 0.5) === row.target);
        predicted += p;
    }

    return {
        logLoss: loss / rows.length,
        brier: brier / rows.length,
        accuracy: correct / rows.length,
        meanPrediction: predicted / rows.length,
    };
}

module.exports = { fitLogistic, predictRadiant, evaluateLogistic };