/**
 * Pick an item from the given array by weighted probability evaluation functions.
 *
 * Each evaluator scores every element; scores are normalized to [0, 1] per evaluator,
 * then combined with the given weights. The element with the highest total wins.
 *
 * NOTICE: Ported from vrm-c/bvh2vrma (MIT). Original:
 * https://github.com/vrm-c/bvh2vrma/blob/main/src/lib/bvh-converter/pickByProbability.ts
 */
export function pickByProbability<T>(
  array: T[],
  evaluators: { func: (value: T) => number, weight: number }[],
): T | null {
  if (array.length < 1)
    return null

  const results = array.map(() => 0.0)

  for (const { func, weight } of evaluators) {
    let min = Infinity
    let max = -Infinity

    const scores = array.map((value) => {
      const s = func(value)
      min = Math.min(min, s)
      max = Math.max(max, s)
      return s
    })

    const range = max - min
    if (range > 0.0) {
      scores.forEach((v, i) => {
        results[i] += weight * (v - min) / range
      })
    }
  }

  let bestIdx = 0
  let bestVal = -Infinity
  for (const [i, r] of results.entries()) {
    if (r > bestVal) {
      bestVal = r
      bestIdx = i
    }
  }

  return array[bestIdx]
}
