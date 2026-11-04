// Human-like typing plan. Pure (no browser), so it can be unit-tested.
//
// The reply is cut into small bursts of graphemes (Vietnamese diacritics and
// emoji stay whole), each followed by a jittered pause proportional to its
// length, with longer pauses after punctuation and line breaks. Long replies
// are typed in bigger bursts and with shorter pauses so the whole run stays
// within `maxMs`; `minStepMs` bounds the number of browser round trips.

const PUNCT_PAUSE = /[.,!?;:…)]\s*$/;
const graphemes = text => [...new Intl.Segmenter('vi', { granularity: 'grapheme' }).segment(text)].map(s => s.segment);

/**
 * @returns {Array<{kind:'text', text:string, delayMs:number} | {kind:'newline', delayMs:number}>}
 *          delayMs = pause after the step
 */
export function planTyping(text, { cps = 8, maxMs = 30_000, minStepMs = 120, random = Math.random } = {}) {
  const lines = String(text).split('\n').map(graphemes);
  const total = lines.reduce((n, l) => n + l.length, 0);
  if (!total) return [];
  const perChar = 1000 / cps;
  // Natural duration (chars + average punctuation/newline pauses), then shrink to fit the budget.
  const natural = total * perChar + lines.length * 500;
  const scale = Math.min(1, maxMs / natural);
  const maxSteps = Math.max(1, Math.floor(maxMs / minStepMs));
  const minChunk = Math.max(1, Math.ceil(total / maxSteps));
  const jitter = () => 0.6 + random() * 0.8;

  const steps = [];
  lines.forEach((chars, lineIndex) => {
    if (lineIndex > 0) steps.push({ kind: 'newline', delayMs: Math.round((350 + random() * 450) * scale) });
    for (let i = 0; i < chars.length;) {
      const size = Math.min(chars.length - i, minChunk + Math.floor(random() * 3)); // bursts of 1-3 (or more when long)
      const chunk = chars.slice(i, i + size).join('');
      i += size;
      let delay = size * perChar * jitter();
      if (PUNCT_PAUSE.test(chunk)) delay += 150 + random() * 350;
      else if (chunk.endsWith(' ') && random() < 0.15) delay += 100 + random() * 250; // occasional word-gap hesitation
      steps.push({ kind: 'text', text: chunk, delayMs: Math.round(delay * scale) });
    }
  });
  if (steps.length) steps[steps.length - 1].delayMs = 0;
  // Jitter can overshoot the budget slightly; trim proportionally.
  const sum = plannedDurationMs(steps);
  if (sum > maxMs) for (const s of steps) s.delayMs = Math.floor(s.delayMs * (maxMs / sum));
  return steps;
}

export function plannedDurationMs(steps) {
  return steps.reduce((n, s) => n + s.delayMs, 0);
}
