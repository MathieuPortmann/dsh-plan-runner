import test from 'node:test';
import assert from 'node:assert/strict';
import { planSlug, withStartNudge, START_NUDGE } from '../lib/plan-file.js';

test('planSlug: first heading, ASCII words joined by dashes, 40 characters at most', () => {
  assert.equal(planSlug('# Migrer la base de données\n1. x'), 'migrer-la-base-de-donnees');
  assert.equal(planSlug('no heading here'), 'plan');
  assert.equal(planSlug('# ' + 'word '.repeat(30)).length <= 40, true);
  assert.equal(planSlug('# ***'), 'plan');
});

test('accepted plan gets the start reminder', () => {
  assert.match(withStartNudge('Plan accepted.'), /Run step by step/);
  const r = withStartNudge({ content: [{ type: 'text', text: 'User approved the plan' }] });
  assert.equal(r.content.at(-1).text, START_NUDGE);
});

test('refused plan is left alone', () => {
  assert.equal(withStartNudge('The user rejected the plan'), 'The user rejected the plan');
  const e = { isError: true, content: [] };
  assert.equal(withStartNudge(e), e);
});
