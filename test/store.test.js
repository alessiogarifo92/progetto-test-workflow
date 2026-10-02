import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMESPACE,
  VERSION,
  storageKey,
  getLocalStorage,
  createStore,
} from '../src/store.js';

// Fake Storage that records every call, so tests can assert exactly what was touched.
function fakeBacking(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = { getItem: [], setItem: [], removeItem: [] };
  return {
    data,
    calls,
    getItem(key) {
      calls.getItem.push(key);
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      calls.setItem.push([key, value]);
      data.set(key, String(value));
    },
    removeItem(key) {
      calls.removeItem.push(key);
      data.delete(key);
    },
  };
}

function quotaError() {
  const e = new Error('The quota has been exceeded.');
  e.name = 'QuotaExceededError';
  return e;
}

function securityError() {
  const e = new Error('The operation is insecure.');
  e.name = 'SecurityError';
  return e;
}

test('constants and storageKey', () => {
  assert.equal(NAMESPACE, 'focusTimer');
  assert.equal(VERSION, 1);
  assert.equal(storageKey('state'), 'focusTimer:v1:state');
  assert.equal(storageKey('settings'), 'focusTimer:v1:settings');
  assert.equal(storageKey('state', 0), 'focusTimer:v0:state');
  assert.equal(storageKey('state', 7), 'focusTimer:v7:state');
});

test('getLocalStorage returns the localStorage of a normal global', () => {
  const fake = fakeBacking();
  assert.equal(getLocalStorage({ localStorage: fake }), fake);
});

test('getLocalStorage returns null when the property is missing or null', () => {
  assert.equal(getLocalStorage({}), null);
  assert.equal(getLocalStorage({ localStorage: null }), null);
  assert.equal(getLocalStorage({ localStorage: undefined }), null);
});

test('getLocalStorage returns null when reading the property throws SecurityError', () => {
  const g = {
    get localStorage() {
      throw securityError();
    },
  };
  assert.equal(getLocalStorage(g), null);
});

test('getLocalStorage defaults to globalThis without throwing (no window in node)', () => {
  assert.doesNotThrow(() => getLocalStorage());
});

test('state roundtrip', () => {
  const backing = fakeBacking();
  const store = createStore(backing);
  const state = { phase: 'work', remainingMs: 1500000, completed: 3, nested: { a: [1, 2, null] } };
  assert.equal(store.saveState(state), true);
  assert.deepEqual(store.loadState(), state);
  assert.equal(store.isPersistent(), true);
  assert.equal(backing.data.get('focusTimer:v1:state'), JSON.stringify(state));
});

test('settings roundtrip', () => {
  const backing = fakeBacking();
  const store = createStore(backing);
  const settings = { workMin: 25, breakMin: 5, sound: false };
  assert.equal(store.saveSettings(settings), true);
  assert.deepEqual(store.loadSettings(), settings);
  assert.deepEqual(store.loadState(), null);
});

test('a second store on the same backing sees the persisted data', () => {
  const backing = fakeBacking();
  createStore(backing).saveState({ n: 1 });
  assert.deepEqual(createStore(backing).loadState(), { n: 1 });
});

test('missing key returns null', () => {
  const store = createStore(fakeBacking());
  assert.equal(store.loadState(), null);
  assert.equal(store.loadSettings(), null);
});

test('invalid JSON returns null instead of throwing', () => {
  const backing = fakeBacking({
    'focusTimer:v1:state': '{not json',
    'focusTimer:v1:settings': '',
  });
  const store = createStore(backing);
  assert.doesNotThrow(() => store.loadState());
  assert.equal(store.loadState(), null);
  assert.equal(store.loadSettings(), null);
  // corrupt data is not a storage fault
  assert.equal(store.isPersistent(), true);
});

test('does not validate the domain shape: any valid JSON value is returned', () => {
  const backing = fakeBacking({
    'focusTimer:v1:state': '[1,2,3]',
    'focusTimer:v1:settings': '"hello"',
  });
  const store = createStore(backing);
  assert.deepEqual(store.loadState(), [1, 2, 3]);
  assert.equal(store.loadSettings(), 'hello');
});

test('backing null: works in memory, isPersistent false', () => {
  const store = createStore(null);
  assert.equal(store.isPersistent(), false);
  assert.equal(store.loadState(), null);
  assert.equal(store.saveState({ a: 1 }), false);
  assert.deepEqual(store.loadState(), { a: 1 });
  assert.equal(store.saveSettings({ b: 2 }), false);
  assert.deepEqual(store.loadSettings(), { b: 2 });
  assert.equal(store.isPersistent(), false);
});

test('backing undefined is treated like null', () => {
  const store = createStore(undefined);
  assert.equal(store.isPersistent(), false);
  store.saveState({ a: 1 });
  assert.deepEqual(store.loadState(), { a: 1 });
});

test('memory fallback returns a copy, not the live object', () => {
  const store = createStore(null);
  const state = { a: 1 };
  store.saveState(state);
  state.a = 99;
  assert.deepEqual(store.loadState(), { a: 1 });
});

test('getItem throwing: load returns null, store falls back to memory', () => {
  const backing = fakeBacking();
  backing.getItem = () => {
    throw securityError();
  };
  const store = createStore(backing);
  assert.equal(store.isPersistent(), true);
  assert.doesNotThrow(() => store.loadState());
  assert.equal(store.loadState(), null);
  assert.equal(store.isPersistent(), false);
  // keeps working in memory afterwards
  assert.equal(store.saveState({ ok: true }), false);
  assert.deepEqual(store.loadState(), { ok: true });
  assert.equal(backing.calls.setItem.length, 0);
});

test('setItem throwing QuotaExceededError: save false, memory read-back, not persistent', () => {
  const backing = fakeBacking();
  backing.setItem = () => {
    throw quotaError();
  };
  const store = createStore(backing);
  assert.equal(store.isPersistent(), true);
  assert.doesNotThrow(() => store.saveState({ v: 1 }));
  assert.equal(store.isPersistent(), false);
  assert.equal(store.saveState({ v: 2 }), false);
  assert.deepEqual(store.loadState(), { v: 2 });
  assert.equal(store.saveSettings({ s: 1 }), false);
  assert.deepEqual(store.loadSettings(), { s: 1 });
});

test('after a setItem failure the saved value is readable and the fallback is permanent', () => {
  const backing = fakeBacking();
  let fail = true;
  const realSet = backing.setItem;
  backing.setItem = (k, v) => {
    if (fail) throw quotaError();
    realSet(k, v);
  };
  const store = createStore(backing);
  assert.equal(store.saveState({ v: 1 }), false);
  assert.deepEqual(store.loadState(), { v: 1 });
  fail = false; // storage recovers, store must stay on memory
  assert.equal(store.saveState({ v: 2 }), false);
  assert.equal(store.isPersistent(), false);
  assert.deepEqual(store.loadState(), { v: 2 });
  assert.equal(backing.data.size, 0);
});

test('namespacing: only focusTimer keys are touched, foreign keys are never read/written/removed', () => {
  const backing = fakeBacking({
    'otherApp:v1:state': '{"x":1}',
    history: '["a"]',
    'focusTimerFake:v1:state': '1',
  });
  const store = createStore(backing);
  store.loadState();
  store.loadSettings();
  store.saveState({ a: 1 });
  store.saveSettings({ b: 2 });
  store.loadState();
  store.loadSettings();

  const touched = [
    ...backing.calls.getItem,
    ...backing.calls.setItem.map(([k]) => k),
    ...backing.calls.removeItem,
  ];
  assert.ok(touched.length > 0);
  for (const k of touched) assert.ok(k.startsWith('focusTimer:'), `touched foreign key ${k}`);
  assert.deepEqual(backing.calls.removeItem, []);
  assert.deepEqual(backing.calls.setItem.map(([k]) => k).sort(), [
    'focusTimer:v1:settings',
    'focusTimer:v1:state',
  ]);
  assert.equal(backing.data.get('otherApp:v1:state'), '{"x":1}');
  assert.equal(backing.data.get('history'), '["a"]');
  assert.equal(backing.data.get('focusTimerFake:v1:state'), '1');
  assert.deepEqual([...backing.data.keys()].sort(), [
    'focusTimer:v1:settings',
    'focusTimer:v1:state',
    'focusTimerFake:v1:state',
    'history',
    'otherApp:v1:state',
  ]);
});

test('saveState performs exactly one setItem call (atomic completion)', () => {
  const backing = fakeBacking();
  const store = createStore(backing);
  store.saveState({ phase: 'break', completed: 4, log: [1, 2, 3] });
  assert.equal(backing.calls.setItem.length, 1);
  assert.equal(backing.calls.setItem[0][0], 'focusTimer:v1:state');
  store.saveSettings({ a: 1 });
  assert.equal(backing.calls.setItem.length, 2);
});

test('a huge / odd object still roundtrips', () => {
  const big = {
    list: Array.from({ length: 20000 }, (_, i) => ({ i, s: 'x'.repeat(10) })),
    unicode: 'à€😀\u0000"\\\n',
    '': 'empty key',
    nested: { a: { b: { c: { d: [[[[1]]]] } } } },
    num: -0.000001,
    nul: null,
  };
  const store = createStore(fakeBacking());
  assert.equal(store.saveState(big), true);
  assert.deepEqual(store.loadState(), big);
});

test('saveState(undefined) does not throw and does not corrupt the stored value', () => {
  const backing = fakeBacking();
  const store = createStore(backing);
  store.saveState({ keep: 1 });
  let result;
  assert.doesNotThrow(() => {
    result = store.saveState(undefined);
  });
  assert.equal(result, false);
  assert.deepEqual(store.loadState(), { keep: 1 });
  assert.equal(store.isPersistent(), true);
});

test('unserializable values (circular, BigInt) do not throw', () => {
  const store = createStore(fakeBacking());
  const circ = {};
  circ.self = circ;
  assert.doesNotThrow(() => store.saveState(circ));
  assert.equal(store.saveState(circ), false);
  assert.equal(store.saveSettings({ n: 1n }), false);
  assert.equal(store.isPersistent(), true);
  assert.equal(store.loadState(), null);
});

test('saving null roundtrips as null', () => {
  const store = createStore(fakeBacking());
  assert.equal(store.saveState(null), true);
  assert.equal(store.loadState(), null);
});

test('migration v0 -> v1: result written under v1, old key kept', () => {
  const backing = fakeBacking({
    'focusTimer:v0:state': JSON.stringify({ secs: 90 }),
    'focusTimer:v0:settings': JSON.stringify({ work: 25 }),
    'otherApp:v1:state': 'foreign',
  });
  const seen = [];
  const store = createStore(backing, {
    version: 1,
    migrations: {
      0: (raw) => {
        seen.push(raw);
        return {
          state: raw.state && { remainingMs: raw.state.secs * 1000 },
          settings: raw.settings && { workMin: raw.settings.work },
        };
      },
    },
  });
  assert.deepEqual(store.loadState(), { remainingMs: 90000 });
  assert.deepEqual(seen[0], { state: { secs: 90 }, settings: { work: 25 } });
  assert.equal(backing.data.get('focusTimer:v1:state'), JSON.stringify({ remainingMs: 90000 }));
  // old keys are kept
  assert.equal(backing.data.get('focusTimer:v0:state'), JSON.stringify({ secs: 90 }));
  assert.equal(backing.data.get('focusTimer:v0:settings'), JSON.stringify({ work: 25 }));
  assert.deepEqual(backing.calls.removeItem, []);
  // settings migrate too
  assert.deepEqual(store.loadSettings(), { workMin: 25 });
  // foreign untouched
  assert.equal(backing.data.get('otherApp:v1:state'), 'foreign');
  // later loads read the v1 key, no re-migration
  const before = seen.length;
  assert.deepEqual(store.loadState(), { remainingMs: 90000 });
  assert.equal(seen.length, before);
});

test('migration: an existing current-version key wins, migrations are not run', () => {
  const backing = fakeBacking({
    'focusTimer:v0:state': '{"secs":1}',
    'focusTimer:v1:state': '{"remainingMs":5}',
  });
  let ran = false;
  const store = createStore(backing, {
    version: 1,
    migrations: { 0: (r) => ((ran = true), r) },
  });
  assert.deepEqual(store.loadState(), { remainingMs: 5 });
  assert.equal(ran, false);
});

test('migration chain walks down to the newest older key and applies each step', () => {
  const backing = fakeBacking({
    'focusTimer:v0:state': '{"a":"old"}',
    'focusTimer:v1:state': '{"n":1}',
  });
  const order = [];
  const store = createStore(backing, {
    version: 3,
    migrations: {
      0: (r) => (order.push(0), r),
      1: (r) => (order.push(1), { state: { n: r.state.n + 1 }, settings: r.settings }),
      2: (r) => (order.push(2), { state: { n: r.state.n * 10 }, settings: r.settings }),
    },
  });
  assert.deepEqual(store.loadState(), { n: 20 });
  assert.deepEqual(order, [1, 2]);
  assert.equal(backing.data.get('focusTimer:v3:state'), '{"n":20}');
  assert.equal(backing.data.get('focusTimer:v1:state'), '{"n":1}');
  assert.equal(backing.data.get('focusTimer:v0:state'), '{"a":"old"}');
});

test('migration without a function for a step passes the data through unchanged', () => {
  const backing = fakeBacking({ 'focusTimer:v0:state': '{"a":1}' });
  const store = createStore(backing, { version: 1, migrations: {} });
  assert.deepEqual(store.loadState(), { a: 1 });
});

test('migration that throws: load returns null, nothing written, still persistent', () => {
  const backing = fakeBacking({ 'focusTimer:v0:state': '{"a":1}' });
  const store = createStore(backing, {
    version: 1,
    migrations: {
      0: () => {
        throw new Error('boom');
      },
    },
  });
  assert.doesNotThrow(() => store.loadState());
  assert.equal(store.loadState(), null);
  assert.equal(backing.calls.setItem.length, 0);
  assert.equal(store.isPersistent(), true);
});

test('migration with invalid JSON in the old key yields null for that name', () => {
  const backing = fakeBacking({ 'focusTimer:v0:state': '{oops' });
  const store = createStore(backing, { version: 1, migrations: {} });
  assert.equal(store.loadState(), null);
  assert.equal(backing.calls.setItem.length, 0);
});

test('keys of a newer version are ignored', () => {
  const backing = fakeBacking({
    'focusTimer:v2:state': '{"future":true}',
    'focusTimer:v2:settings': '{"future":true}',
  });
  const store = createStore(backing); // current version 1
  assert.equal(store.loadState(), null);
  assert.equal(store.loadSettings(), null);
  store.saveState({ now: 1 });
  assert.deepEqual(store.loadState(), { now: 1 });
  assert.equal(backing.data.get('focusTimer:v2:state'), '{"future":true}');
  assert.equal(backing.data.get('focusTimer:v2:settings'), '{"future":true}');
  assert.deepEqual(backing.calls.removeItem, []);
  assert.ok(!backing.calls.getItem.includes('focusTimer:v2:state'));
});

test('migration read failure falls back to memory without throwing', () => {
  const backing = fakeBacking({ 'focusTimer:v0:state': '{"a":1}' });
  backing.getItem = (k) => {
    if (k === 'focusTimer:v0:state') throw securityError();
    return null;
  };
  const store = createStore(backing, { version: 1, migrations: {} });
  assert.equal(store.loadState(), null);
  assert.equal(store.isPersistent(), false);
});

test('default options use VERSION 1 with no migrations', () => {
  const backing = fakeBacking({ 'focusTimer:v0:state': '{"a":1}' });
  const store = createStore(backing);
  // v0 exists but with no migration the data passes through (identity chain)
  assert.deepEqual(store.loadState(), { a: 1 });
  assert.equal(backing.data.has('focusTimer:v1:state'), true);
});

// ---- review fixes -------------------------------------------------------

function failingSetItem(backing) {
  backing.setItem = () => { throw quotaError(); };
  return backing;
}

test('after a failed saveState the persisted settings are still readable (memory seeded from the backing)', () => {
  const backing = fakeBacking({
    'focusTimer:v1:state': '{"completed":7}',
    'focusTimer:v1:settings': '{"workMin":50}',
  });
  failingSetItem(backing);
  const store = createStore(backing);
  assert.equal(store.saveState({ completed: 8 }), false);
  assert.equal(store.isPersistent(), false);
  assert.deepEqual(store.loadSettings(), { workMin: 50 });
  assert.deepEqual(store.loadState(), { completed: 8 }); // the new value wins over the seeded one
});

test('after a failed saveSettings the persisted state is still readable', () => {
  const backing = fakeBacking({
    'focusTimer:v1:state': '{"completed":7}',
    'focusTimer:v1:settings': '{"workMin":50}',
  });
  failingSetItem(backing);
  const store = createStore(backing);
  assert.equal(store.saveSettings({ workMin: 40 }), false);
  assert.deepEqual(store.loadState(), { completed: 7 });
  assert.deepEqual(store.loadSettings(), { workMin: 40 });
});

test('seeding the memory fallback never throws when getItem also fails', () => {
  const backing = fakeBacking({ 'focusTimer:v1:state': '{"completed":7}' });
  backing.getItem = () => { throw securityError(); };
  failingSetItem(backing);
  const store = createStore(backing);
  assert.equal(store.saveState({ completed: 8 }), false);
  assert.deepEqual(store.loadState(), { completed: 8 });
  assert.equal(store.loadSettings(), null);
});

test('migration result goes through the same JSON round trip as a saved value', () => {
  const when = new Date(Date.UTC(2026, 9, 2));
  const backing = fakeBacking({ 'focusTimer:v0:state': '{"a":1}' });
  const store = createStore(backing, { version: 1, migrations: { 0: () => ({ state: { when, u: undefined, n: NaN } }) } });
  const first = store.loadState();
  const second = store.loadState();
  assert.deepEqual(first, second);
  assert.deepEqual(first, { when: when.toISOString(), n: null });
});

test('a migration yielding a non-serialisable state writes nothing and returns null', () => {
  const backing = fakeBacking({ 'focusTimer:v0:state': '{"a":1}' });
  const store = createStore(backing, { version: 1, migrations: { 0: () => ({ state: () => 1 }) } });
  assert.equal(store.loadState(), null);
  assert.deepEqual(backing.calls.setItem, []);
  assert.equal(store.isPersistent(), true);
});

test('the migration loop stops before the current version', () => {
  const calls = [];
  const backing = fakeBacking({ 'focusTimer:v0:state': '{"a":1}' });
  const store = createStore(backing, {
    version: 1,
    migrations: { 0: (d) => { calls.push(0); return d; }, 1: (d) => { calls.push(1); return d; } },
  });
  store.loadState();
  assert.deepEqual(calls, [0]);
});
