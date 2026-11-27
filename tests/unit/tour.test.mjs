// Unit checks for tour chapters, deep links, and cancellation-safe state transitions.
// Run offline: mvm run -i docker.io/library/node:22-alpine -- node tests/unit/tour.test.mjs
import assert from 'node:assert/strict';
import { TOUR_CHAPTERS, resolveChapterIndex, parseDeepLink, createTourState } from '../../web/tour.js';
import { SHOWCASE_PROJECTS } from '../../web/showcase-projects.js';

let checks = 0;
const check = (name, fn) => {
  try { fn(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};

check('TOUR_CHAPTERS covers 6 unique chapters wired to valid showcase projects', () => {
  assert.equal(TOUR_CHAPTERS.length, 6);
  const projectIds = new Set(SHOWCASE_PROJECTS.map(p => p.id));
  const ids = new Set();
  TOUR_CHAPTERS.forEach((ch, idx) => {
    assert.equal(ch.step, idx + 1);
    assert.ok(!ids.has(ch.id), `duplicate id ${ch.id}`);
    ids.add(ch.id);
    assert.ok(projectIds.has(ch.projectId), `unknown showcase ${ch.projectId}`);
    assert.ok(ch.assistLabel && ch.copy && ch.panel);
  });
});

check('resolveChapterIndex parses 1-based steps and chapter ids', () => {
  assert.equal(resolveChapterIndex(1), 0);
  assert.equal(resolveChapterIndex('6'), 5);
  assert.equal(resolveChapterIndex('xray'), 1);
  assert.equal(resolveChapterIndex('DEBUG'), 2);
  assert.equal(resolveChapterIndex(0), -1);
  assert.equal(resolveChapterIndex('7'), -1);
  assert.equal(resolveChapterIndex('nope'), -1);
});

check('parseDeepLink handles ?tour=... and ?showcase=... safely', () => {
  assert.deepEqual(parseDeepLink('?tour=1'), { kind: 'tour', index: 0 });
  assert.deepEqual(parseDeepLink('?tour=true'), { kind: 'tour', index: 0 });
  assert.deepEqual(parseDeepLink('?tour='), { kind: 'tour', index: 0 });
  assert.deepEqual(parseDeepLink('?tour=debug'), { kind: 'tour', index: 2 });
  assert.deepEqual(parseDeepLink('?tour=5'), { kind: 'tour', index: 4 });
  assert.equal(parseDeepLink('?tour=99'), null);
  assert.deepEqual(parseDeepLink('?showcase=bug-hunter'), { kind: 'showcase', id: 'bug-hunter' });
  assert.equal(parseDeepLink('?showcase=unknown'), null);
  assert.equal(parseDeepLink(''), null);
});

check('createTourState clamps bounds and invalidates stale async tokens on transition', () => {
  const snapshots = [];
  const machine = createTourState({ onChange: s => snapshots.push(s) });
  const gen1 = machine.start(0);
  assert.equal(machine.isCurrent(gen1), true);
  assert.equal(machine.getState().index, 0);

  const gen2 = machine.next();
  assert.equal(machine.isCurrent(gen1), false, 'previous token invalidated on next');
  assert.equal(machine.isCurrent(gen2), true);
  assert.equal(machine.getState().index, 1);

  machine.markDone(1);
  assert.equal(machine.getState().done.has(1), true);

  machine.goTo(99);
  assert.equal(machine.getState().index, 5, 'clamps high index');
  machine.goTo(-5);
  assert.equal(machine.getState().index, 0, 'clamps low index');

  const gen3 = machine.getState().gen;
  machine.stop();
  assert.equal(machine.getState().active, false);
  assert.equal(machine.isCurrent(gen3), false, 'stop invalidates active token');
  assert.ok(snapshots.length >= 6);
});

console.log(`Unit checks passed (${checks} checks)`);
