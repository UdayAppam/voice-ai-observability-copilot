// Line-level diff utility for V4 Apply modal + receipt.
// Pure JS, no deps. Returns an array of segments:
//   { type: 'equal' | 'added' | 'removed', text }
//
// Used for two visual diffs:
//   1. CURRENT agentPrompt vs PROPOSED prompt (diff modal)
//   2. AI-suggested text vs USER-edited final text (receipt panel)

// Compute the longest common subsequence of lines — classic dynamic-programming
// implementation. O(n*m) memory; fine for prompts under ~10K chars.
function lcs(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  // Walk back to produce segments
  const out = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j])         { out.push({ type: 'equal',   text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'removed', text: a[i] }); i++ }
    else                       { out.push({ type: 'added',   text: b[j] }); j++ }
  }
  while (i < m) out.push({ type: 'removed', text: a[i++] })
  while (j < n) out.push({ type: 'added',   text: b[j++] })
  return out
}

// Public API — diff two strings as lines. Returns segments.
export function lineDiff(before, after) {
  const a = (before || '').split('\n')
  const b = (after  || '').split('\n')
  return lcs(a, b)
}

// Summary helper for status pills + receipts: "+74 chars, +2 lines"
export function diffSummary(before, after) {
  if (before === after) return 'no change'
  const dChars = (after || '').length - (before || '').length
  const dLines = ((after || '').split('\n').length) - ((before || '').split('\n').length)
  const sign = (n) => (n > 0 ? `+${n}` : `${n}`)
  return `${sign(dChars)} chars, ${sign(dLines)} lines`
}

// Returns just the count of changed characters (for the "✎ edited N chars" indicator)
export function charsDiff(before, after) {
  return Math.abs((after || '').length - (before || '').length)
}
