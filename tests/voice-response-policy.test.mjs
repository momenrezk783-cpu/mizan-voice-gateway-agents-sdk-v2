import assert from 'node:assert/strict';
import fs from 'node:fs';

const prompt = fs.readFileSync('src/lib/conversation-manager/prompt.ts', 'utf8');
const manager = fs.readFileSync('src/lib/conversation-manager/manager.ts', 'utf8');
const restrictions = /(?:\b(?:aim\s*<=?\s*\d+\s*words?|max(?:imum)?\s*\d+\s*words?|hard\s*cap\s*\d+|\d+\s*words?\s*(?:per\s*(?:reply|turn|response)|limit|cap)|(?:under|at\s*most|no\s*more\s*than|limit(?:ed)?\s*to)\s*\d+\s*words?)\b|[٠-٩0-9]+\s*كلم(?:ة|ات)?)/iu;
assert.match('25 words per reply', restrictions, 'guard must catch 25-word caps');
assert.match('20 words per turn', restrictions, 'guard must catch alternate caps');
assert.match('25 كلمة', restrictions, 'guard must catch Arabic caps');
const sources = [
  ['prompt.ts', prompt],
  ['manager.ts', manager]
];
if (fs.existsSync('master-system-prompt.md')) {
  sources.push(['master-system-prompt.md', fs.readFileSync('master-system-prompt.md', 'utf8')]);
}
for (const [path, source] of sources) {
  assert.doesNotMatch(source, restrictions, `${path} restored a fixed word cap`);
  assert.doesNotMatch(source, /ask\s+ONCE\s+if\s+they\s+need\s+anything\s+else/iu, `${path} restored an obligatory closing question`);
}
assert.match(prompt, /Never apply a fixed word or sentence limit/);
assert.match(prompt, /Do NOT automatically end replies with a question/);
assert.match(prompt, /genuinely different concrete scenario/);
assert.match(prompt, /overrides legacy response-style restrictions/);
assert.match(manager, /end_call without asking another question/);
console.log('PASS: no fixed word cap, no automatic end-of-turn questions, varied concrete examples, no forced closing question');
