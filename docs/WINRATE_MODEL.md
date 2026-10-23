# How the winrate model works

This file is intended as a thorough explanation on the mathematics behind the winrate calculation model. It uses real-world examples to keep information as down-to-earth as possible.

You do not need a background in statistics or machine learning to follow this guide. Each equation comes with an explanation and a worked example.

> **Development status:** This guide describes the experimental learned model in this repository. The frontend currently uses an earlier calculation. Training and evaluating this model does not automatically replace the frontend calculator.
>
> Unless stated otherwise, the example numbers below are invented to explain the mathematics. They are not published hero ratings.

## 1. Start with a fruit stall

Imagine a fruit stall offering customers a choice between two baskets.

We record:

- What each basket contains.
- How much of its fruit is ripe.
- How much is bruised.
- Which basket the customer chooses.

After recording thousands of choices, we want to estimate which basket the next customer will choose.

We could invent rules ourselves:

- Add points for apples.
- Remove points for bruises.
- Add more points for ripe fruit.

However, we would be guessing how much each thing matters.

Instead, we let a program examine past choices and find numbers that help explain those choices.

That is the basic idea behind this model.

For Dota, the two baskets become the two teams. Their contents become the selected heroes and measurements of their composition. The recorded result becomes which team won.

## 2. A feature is something we measure

A **feature** is one piece of information the program can use.

For our fruit stall, features might include:

- Whether a basket contains apples.
- Its proportion of ripe fruit.
- Its proportion of bruised fruit.

For the actual draft model, the feature groups are:

| Group | What the program measures |
| --- | --- |
| Hero identities | Which heroes are on each team. |
| Capability counts | How many heroes have tags such as Carry, Support, Initiator or Disabler. |
| Attribute counts | How many Strength, Agility, Intelligence or Universal heroes each team has. |
| Position measurements | How naturally the lineup fits positions 1–5, and how much evidence supports those observations. |

The developers choose these measurements. The program learns how strongly to weight them.

It cannot automatically invent a new measurement such as “this team cannot defend its towers.” We would need to give it information capable of describing that problem.

### Comparing the two sides

The real model describes Radiant relative to Dire.

For a hero identity:

| Situation | Feature value |
| --- | ---: |
| Radiant picked the hero | +1 |
| Dire picked the hero | -1 |
| Neither team picked the hero | 0 |

A hero ID identifies the hero. A larger ID does not mean a stronger hero.

For other measurements, we subtract:

```text
feature value = Radiant measurement − Dire measurement
```

For example:

```text
Radiant position-fit measurement: 0.70
Dire position-fit measurement:    0.40

Difference: 0.70 − 0.40 = +0.30
```

A positive difference means Radiant has more of that measured characteristic. Whether that helps Radiant win depends on the learned weight.

### Why count categories separately?

The model has separate indicators for having zero, one, two, three, four or five heroes with each capability tag.

For example, if Radiant has two Support-tagged heroes and Dire has four:

```text
"Exactly two supports" feature:  +1
"Exactly four supports" feature: -1
```

This lets training learn different associations for different counts.

Having two supports does not have to be treated as twice the effect of having one support. Having five does not have to follow the same pattern either.

These capability tags are separate from numbered playing positions. A Support tag and position 5 do not mean exactly the same thing.

## 3. A weight describes how strongly a feature affects the score

Think of a shopping receipt:

```text
item quantity × price per item = contribution to the bill
```

The model uses similar arithmetic:

```text
feature value × learned weight = contribution to the score
```

The difference is that its weights are learned from historical outcomes.

A positive contribution pushes toward Radiant. A negative contribution pushes toward Dire.

Here is an imaginary fruit-basket model:

| Measurement for basket A relative to B | Feature value | Learned weight | Contribution |
| --- | ---: | ---: | ---: |
| A contains apples and B does not | +1.00 | +0.20 | +0.20 |
| A has a higher ripe-fruit proportion | +0.30 | +0.80 | +0.24 |
| A has a higher bruised-fruit proportion | +0.10 | -0.40 | -0.04 |

The arithmetic is:

```text
Apples:  1.00 ×  0.20 = +0.20
Ripeness: 0.30 ×  0.80 = +0.24
Bruises:  0.10 × -0.40 = -0.04

Combined contribution:
0.20 + 0.24 − 0.04 = 0.40
```

The negative weight for bruises means that having more bruised fruit lowers basket A's score.

These are score contributions. They are not percentage points.

## 4. Add the contributions and a starting offset

The model adds all feature contributions to a starting offset:

```text
total score = starting offset + all feature contributions
```

The technical name for the starting offset is the **intercept**.

At the fruit stall, customers might generally favour the left-hand basket because of its location. The intercept can capture a remaining overall tendency like that.

In Dota, the intercept can capture an overall Radiant tendency in the training sample after accounting for the other inputs.

Continuing our invented example:

```text
Starting offset:       0.10
Feature contributions: 0.40

Total score: 0.10 + 0.40 = 0.50
```

The intercept starts from the training sample's Radiant winrate, converted into score units. Training then adjusts it alongside the feature weights.

A score of `0.50` does not mean a 50% win estimate. We still need to convert it.

## 5. Convert the score into a probability

The model uses a mathematical conversion called the **sigmoid**:

$$
p = \frac{1}{1 + e^{-z}}
$$

The symbols mean:

- `z` is the total score.
- `p` is the resulting probability, between 0 and 1.
- `e` is a standard mathematical constant, approximately 2.718.

You do not need to calculate the power by hand. A calculator or computer handles that part.

For our score of `0.50`:

```text
1. Calculate e raised to -0.50:
   approximately 0.60653

2. Add 1:
   1 + 0.60653 = 1.60653

3. Divide 1 by that result:
   1 ÷ 1.60653 ≈ 0.62246

4. Convert to a percentage:
   0.62246 × 100 ≈ 62.25%
```

Our imaginary model therefore estimates a 62.25% chance that the customer chooses basket A.

For a Dota prediction, the same conversion produces a Radiant win estimate.

| Total score | Resulting probability |
| ---: | ---: |
| -1.00 | 26.89% |
| 0.00 | 50% |
| +0.50 | 62.25% |
| +1.00 | 73.11% |

The curve keeps probabilities between 0% and 100%.

It also means the same score adjustment does not always add the same number of percentage points. A contribution matters differently near 50% than near 95%.

## 6. How does the program learn the weights?

Return to the fruit stall.

Suppose the program predicts that customers will choose basket A 90% of the time, but customers repeatedly choose basket B.

Its predictions are making expensive mistakes. Training adjusts the weights to reduce those mistakes across the recorded examples.

For Dota, each training example contains:

- The draft's feature values.
- The actual winner.

The outcome is represented as:

```text
1 = Radiant won
0 = Dire won
```

All weights are fitted together. This matters because several measurements can describe overlapping aspects of a lineup.

A hero might also contribute to the Carry count, Agility count and position-fit measurements. Training considers their combined prediction rather than treating each measurement as an isolated explanation.

### Measuring a prediction's mistake

The main training error measure is called **log loss**.

One convenient way to describe it is:

```text
penalty = -ln(probability assigned to the outcome that happened)
```

`ln` is a calculator function called the natural logarithm. Here, it turns a small probability assigned to the actual outcome into a large penalty. The minus sign makes that penalty positive.

Suppose Radiant was given a 90% chance:

| Actual result | Probability assigned to that result | Penalty |
| --- | ---: | ---: |
| Radiant wins | 0.90 | approximately 0.105 |
| Dire wins | 0.10 | approximately 2.303 |

For comparison, a 50% prediction receives a penalty of approximately 0.693 whichever side wins.

Confidently wrong predictions receive a much larger penalty than uncertain predictions.

Training averages these penalties across the training matches and adjusts the weights to improve that average.

The numerical optimizer used in the code is called L-BFGS. Its job is to find better-fitting weights using calculated directions of improvement.

## 7. Avoid learning too much from a few lucky examples

Imagine that only three customers have seen a basket containing dragon fruit. All three choose it.

Declaring dragon fruit an almost guaranteed winner would be premature.

Perhaps the other baskets were poor. Perhaps those customers particularly liked dragon fruit. Perhaps it was chance.

The model uses **regularization** to discourage unnecessarily large weights.

Its training cost is:

```text
training cost = average prediction penalty + weight penalty
```

The weight penalty is calculated by squaring the weights, adding them together, and multiplying by a regularization setting divided by two.

Using our invented weights:

```text
Weights: +0.20, +0.80, -0.40

Squared weights:
0.20 × 0.20 = 0.04
0.80 × 0.80 = 0.64
-0.40 × -0.40 = 0.16

Total: 0.04 + 0.64 + 0.16 = 0.84
```

With a regularization setting of `0.01`:

```text
Weight penalty:
0.01 ÷ 2 × 0.84 = 0.0042
```

Large positive and negative weights both incur a penalty. The intercept is excluded.

A large weight must improve the training fit enough to justify its additional penalty.

The program tries several regularization settings. Later evaluation helps determine which setting works best.

Regularization reduces the temptation to chase accidental patterns. It does not guarantee that every learned pattern is reliable.

## 8. Use different matches for learning, choosing and testing

A student should practise before an exam. Their exam should contain questions they have not already memorized.

We apply a similar separation to historical matches:

| Group | Approximate share | Purpose |
| --- | ---: | --- |
| Training | Oldest 70% | Fit the weights. |
| Validation | Next 15% | Choose between candidate models and regularization settings. |
| Test | Newest 15% | Assess the chosen model after selection. |

For 10,000 usable matches, the target would be approximately 7,000, 1,500 and 1,500 matches.

The implementation keeps whole UTC days together, so the actual proportions vary.

The benchmark compares constant predictions and models using increasingly broad feature groups:

- Hero identities.
- Hero identities plus capability and attribute counts.
- Those features plus position measurements.

It selects the candidate with the lowest validation log loss. That validation comparison measures prediction error without adding the training weight penalty.

Additional measurements are useful only if they help on unseen matches. A simpler candidate can win the comparison.

For position-aware evaluation, the position observations are frozen first. Validation and test matches must occur afterward.

This prevents us from using knowledge collected later while claiming to predict an earlier match.

The readiness checker verifies that timing requirement. Passing it does not establish that the model predicts well.

## 9. Understand position fit using kitchen appliances

Imagine a kitchen with five jobs:

- Heat water.
- Blend fruit.
- Toast bread.
- Cook rice.
- Keep food cold.

Five kettles provide plenty of water-heating capacity, but poor coverage of the kitchen's other jobs.

A varied set of appliances can cover those jobs more naturally. Some appliances can also perform several jobs.

The position analyzer asks a similar question about a draft:

> Can these five heroes reasonably cover five different positions?

Heroes are more flexible than appliances. The analyzer uses observed playing frequencies rather than treating unusual assignments as physically impossible.

### Observed frequency

If a hero played offlane in 80 of 100 classified matches:

```text
Observed offlane share:
80 ÷ 100 = 0.80, or 80%
```

This describes how the hero was played. It does not mean the hero won 80% of those matches.

### Why add half a match?

The analyzer adds a small cushion to each position count:

```text
Smoothed position share =
(position count + 0.5) ÷ (classified match count + 2.5)
```

There are five positions, so adding `0.5` to each adds `2.5` overall.

For the example:

```text
(80 + 0.5) ÷ (100 + 2.5)
= 80.5 ÷ 102.5
≈ 0.7854
```

An unobserved position receives a small nonzero value:

```text
0.5 ÷ 102.5 ≈ 0.0049
```

This prevents “we have not observed it” from becoming “it is impossible.”

These are adjustments inside the formula. No imaginary matches are inserted into the history.

A hero with no classified position observations remains unavailable for analysis. Smoothing alone is not treated as evidence of flexibility.

### Trying every assignment

There are:

```text
5 × 4 × 3 × 2 × 1 = 120
```

ways to assign five heroes to five positions.

There are five choices for the first position, four remaining choices for the next, then three, two and one.

The analyzer evaluates all 120 arrangements.

For an arrangement, it multiplies the five relevant position shares. If every placement has a share of `0.80`:

```text
0.80 × 0.80 × 0.80 × 0.80 × 0.80 = 0.32768
```

If one placement instead has a share of `0.01`:

```text
0.80 × 0.80 × 0.80 × 0.80 × 0.01 = 0.004096
```

The forced unusual placement lowers the arrangement's compatibility considerably.

The multiplication assumes independent position preferences. Its result is a compatibility score, not a calibrated probability of the players choosing those roles or winning the match.

### Bringing the combined fit back to a familiar scale

One measurement uses the **geometric mean**.

For five placements, this is the fifth root of their multiplied shares. A fifth root asks:

> What number, multiplied by itself five times, produces this result?

For five shares of `0.80`, the geometric mean is `0.80`.

For the arrangement with four shares of `0.80` and one of `0.01`, it is approximately `0.3330`.

This gives us an overall fit measurement on a comparable scale. It still is not a win probability.

### The seven position measurements

| Measurement | Plain-language meaning |
| --- | --- |
| Best geometric share | How naturally the best arrangement fits overall. |
| Weakest assigned share | How unusual its least natural placement is. |
| Assignment mass | Combined compatibility across all valid arrangements. |
| Assignment entropy | Whether one arrangement stands out or many receive similar scores. |
| Minimum classification coverage | How completely the available matches were accounted for by position counts. |
| Maximum assigned interval width | How imprecise the least certain placement's frequency estimate is. |
| Minimum observed hour fraction | How much of the intended observation window is available for the least-covered hero. |

Many equally scored arrangements can be equally poor. That is why fit and the spread of arrangement scores are measured separately.

These measurements become inputs to the learned prediction. None carries a fixed winrate penalty.

## 10. A measured frequency also needs context

Tasting one apple tells you less about an orchard than inspecting hundreds of apples.

Similarly:

```text
6 offlane matches out of 10 = 60%
600 offlane matches out of 1,000 = 60%
```

The percentages match, but the second estimate rests on much more evidence.

The position profiles include statistical intervals describing uncertainty in the estimated frequencies. The method used is a 95% Wilson interval.

The practical point is that small samples generally produce wider intervals.

These intervals concern playing-position frequency. They are not intervals for the team's win probability, and they do not account for every possible source of bias.

Coverage and interval measurements enter the current model as additional features. The code does not automatically turn them into a separate confidence adjustment that pulls the prediction toward 50%.

## 11. What does “more important” mean?

For a particular prediction, a feature's contribution is:

```text
feature value × learned weight
```

A large weight multiplied by a tiny feature difference can contribute less than a modest weight multiplied by a large difference.

Changing a hero also changes several measurements at once. Its full effect includes:

- Removing one hero identity.
- Adding another.
- Updating capability-count indicators.
- Updating attribute-count indicators.
- Recalculating position fit.

It is therefore misleading to compare two hero coefficients and treat their difference as the entire effect of changing a pick.

The weights describe associations within the fitted model. They do not prove that a particular characteristic independently causes wins.

At the fruit stall, apples might be associated with customer choices partly because of other properties of the baskets containing them. Similar overlaps occur between heroes and composition features.

## 12. What if we do not know which team is Radiant?

The model predicts Radiant wins, but the application describes teams as allies and enemies.

The benchmark inspector evaluates the allies in both possible side assignments.

Using our invented example numbers:

```text
Allies as Radiant: 62.25%
Allies as Dire:    57.44%
```

Assuming either side is equally likely:

```text
Ally estimate:
(62.25 + 57.44) ÷ 2 ≈ 59.85%

Enemy estimate:
100 − 59.85 = 40.15%
```

The actual calculation uses full precision before display rounding.

The equal-side assumption is a design choice. It is not information learned about which side the user actually occupies.

## 13. How do we judge the percentages?

A 70% prediction allows losses.

Across many comparable drafts given approximately 70%, we would want the favoured side to win approximately 70% of the time.

That agreement is called **calibration**.

We also report:

| Measure | What it tells us |
| --- | --- |
| Log loss | How much probability the model assigned to the outcomes that occurred. Lower is better. |
| Brier score | Average squared distance between each probability and its outcome. Lower is better. |
| Accuracy | How often the side given at least 50% won. Higher is better. |

For the Brier score, an 80% Radiant prediction gives:

```text
If Radiant wins:
(0.80 − 1) × (0.80 − 1) = 0.04

If Dire wins:
(0.80 − 0) × (0.80 − 0) = 0.64
```

The model averages these values across the evaluated matches.

Accuracy alone loses information: 51% and 99% both choose the same winner, but a wrong 99% prediction is a much more serious probability error.

## 14. What the current model knows—and what remains outside it

The current learned model uses hero identities, capability counts, attribute counts and empirical position measurements.

It does not yet consume:

- The pairwise values in `synergyMatrix.json`.
- The published baseline hero winrates as explicit inputs.
- Explicit hero-pair counter or synergy features.
- Player skill, item builds or execution.
- The players' actual intended positions.

The position profiles describe popularity of position choices, not their individual winrates.

The final score adds weighted contributions. Some inputs, such as position fit and count indicators, are already more complex measurements of the whole lineup.

Each unique training match currently receives equal weight. User reports do not immediately modify a running model: eligible verified facts must enter an export and a later training run.

A model can also behave poorly on unusual drafts that are scarcely represented in its examples. More elaborate calculations still need evaluation on suitable unseen matches.

## 15. Find the calculations in the source

Paths below are relative to this guide.

| File | Responsibility |
| --- | --- |
| [draftFeatures.cjs](../server/draftFeatures.cjs) | Hero identities, capability counts and attribute counts. |
| [draftPositions.cjs](../server/draftPositions.cjs) | Position-share smoothing and all 120 assignments. |
| [draftPositionFeatures.cjs](../server/draftPositionFeatures.cjs) | The seven position measurements used by the model. |
| [buildHeroPositionProfiles.cjs](../generator/buildHeroPositionProfiles.cjs) | Aggregated observations, coverage and statistical intervals. |
| [logisticRegression.cjs](../server/logisticRegression.cjs) | Weighted scores, probability conversion, fitting and evaluation. |
| [trainDraftBenchmark.cjs](../scripts/trainDraftBenchmark.cjs) | Candidate comparison, regularization selection and saved artifacts. |
| [trainingDataset.cjs](../server/trainingDataset.cjs) | Dataset validation and chronological splitting. |
| [inspectDraftBenchmark.cjs](../scripts/inspectDraftBenchmark.cjs) | Calibration summaries and example feature contributions. |

Inside a saved `model.json`:

```text
featureSpec.featureNames[i] identifies a measurement.
coefficients[i] gives its learned weight.
intercept gives the starting offset.
```

The saved feature specification preserves the definitions and observations needed to reproduce that model's calculations.