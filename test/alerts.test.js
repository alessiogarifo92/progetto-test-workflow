import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlerts } from '../src/alerts.js';

// ---------------------------------------------------------------- fakes

// Fake AudioContext that records the node graph, so tests can assert on it.
// `initialState` is the state right after construction; `resumeTo` is the state after
// resume() (use 'suspended' to model a context the autoplay policy keeps locked).
function fakeAudioCtor({ initialState = 'running', resumeTo = 'running', resumeRejects = false, ctorThrows = false, oscThrows = false } = {}) {
  const instances = [];
  class FakeAudioContext {
    constructor() {
      if (ctorThrows) throw new Error('no audio');
      this.state = initialState;
      this.currentTime = 10;
      this.destination = { kind: 'destination' };
      this.oscillators = [];
      this.gains = [];
      this.resumeCalls = 0;
      instances.push(this);
    }
    resume() {
      this.resumeCalls += 1;
      if (resumeRejects) return Promise.reject(new Error('blocked'));
      this.state = resumeTo;
      return Promise.resolve();
    }
    createOscillator() {
      if (oscThrows) throw new Error('osc failed');
      const osc = {
        type: null,
        frequency: { value: 0 },
        connected: [],
        startCalls: [],
        stopCalls: [],
        connect(node) {
          this.connected.push(node);
        },
        start(t) {
          this.startCalls.push(t);
        },
        stop(t) {
          this.stopCalls.push(t);
        },
      };
      this.oscillators.push(osc);
      return osc;
    }
    createGain() {
      const gain = {
        gain: {
          calls: [],
          setValueAtTime(v, t) {
            this.calls.push(['set', v, t]);
          },
          linearRampToValueAtTime(v, t) {
            this.calls.push(['ramp', v, t]);
          },
        },
        connected: [],
        connect(node) {
          this.connected.push(node);
        },
      };
      this.gains.push(gain);
      return gain;
    }
  }
  FakeAudioContext.instances = instances;
  return FakeAudioContext;
}

// Fake Notification API. `requestPermission` records calls; `mode` picks the flavour.
function fakeNotificationApi({ permission = 'default', mode = 'promise', result = 'granted' } = {}) {
  const api = {
    permission,
    constructed: [],
    requestCalls: 0,
  };
  api.Ctor = function Notification(title, options) {
    api.constructed.push([title, options]);
  };
  Object.defineProperty(api.Ctor, 'permission', { get: () => api.permission });
  api.Ctor.requestPermission = (cb) => {
    api.requestCalls += 1;
    if (mode === 'promise') {
      api.permission = result;
      return Promise.resolve(result);
    }
    if (mode === 'legacy') {
      // Safari legacy form: returns undefined and calls the callback LATER. If the module does
      // not pass a callback, the promise never settles and the test times out.
      setTimeout(() => {
        api.permission = result;
        cb(result);
      }, 0);
      return undefined;
    }
    if (mode === 'reject') return Promise.reject(new Error('nope'));
    if (mode === 'throw') throw new Error('nope');
    throw new Error(`unknown mode ${mode}`);
  };
  return api;
}

// ---------------------------------------------------------------- import safety

test('importing the module touches no global and createAlerts() with no args does not throw', async () => {
  const names = ['window', 'document', 'AudioContext', 'webkitAudioContext', 'Notification'];
  const touched = [];
  const saved = new Map(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  for (const n of names) {
    Object.defineProperty(globalThis, n, {
      configurable: true,
      get() {
        touched.push(n);
        return undefined;
      },
    });
  }
  try {
    const mod = await import('../src/alerts.js?fresh-import');
    const alerts = mod.createAlerts();
    assert.equal(alerts.chime(), false);
    assert.equal(alerts.permission(), 'unsupported');
    assert.deepEqual(touched, []);
  } finally {
    for (const n of names) {
      const d = saved.get(n);
      if (d) Object.defineProperty(globalThis, n, d);
      else delete globalThis[n];
    }
  }
});

// ---------------------------------------------------------------- prime / chime

test('chime() before prime() returns false and creates no context', () => {
  const Ctor = fakeAudioCtor();
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  assert.equal(alerts.chime(), false);
  assert.equal(Ctor.instances.length, 0);
});

test('prime() creates exactly one context; a second prime() does not create another', () => {
  const Ctor = fakeAudioCtor();
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  alerts.prime();
  assert.equal(Ctor.instances.length, 1);
});

test('prime() resumes a suspended context', () => {
  const Ctor = fakeAudioCtor({ initialState: 'suspended' });
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  assert.equal(Ctor.instances[0].resumeCalls, 1);
});

test('prime() does not resume a context that is already running', () => {
  const Ctor = fakeAudioCtor({ initialState: 'running' });
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  assert.equal(Ctor.instances[0].resumeCalls, 0);
});

test('prime() swallows a rejected resume() (no unhandled rejection)', async () => {
  const Ctor = fakeAudioCtor({ initialState: 'suspended', resumeRejects: true });
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.doesNotThrow(() => alerts.prime());
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('prime() swallows a resume() that throws synchronously', () => {
  const Ctor = fakeAudioCtor({ initialState: 'suspended' });
  Ctor.prototype.resume = () => {
    throw new Error('sync boom');
  };
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  assert.doesNotThrow(() => alerts.prime());
});

test('prime() never throws when the constructor throws, and chime() then returns false', () => {
  const alerts = createAlerts({ AudioContextCtor: fakeAudioCtor({ ctorThrows: true }) });
  assert.doesNotThrow(() => alerts.prime());
  assert.equal(alerts.chime(), false);
});

test('prime() and chime() with a missing AudioContextCtor are harmless', () => {
  const alerts = createAlerts({});
  assert.doesNotThrow(() => alerts.prime());
  assert.equal(alerts.chime(), false);
});

test('chime() returns false while the context stays suspended, and plays nothing', () => {
  const Ctor = fakeAudioCtor({ initialState: 'suspended', resumeTo: 'suspended' });
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  assert.equal(alerts.chime(), false);
  assert.equal(Ctor.instances[0].oscillators.length, 0);
});

test('chime() returns false for a closed context', () => {
  const Ctor = fakeAudioCtor({ initialState: 'closed' });
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  assert.equal(alerts.chime(), false);
});

test('chime() returns true once the suspended context has resumed to running', async () => {
  const Ctor = fakeAudioCtor({ initialState: 'suspended', resumeTo: 'running' });
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  await Promise.resolve();
  assert.equal(alerts.chime(), true);
});

test('chime() on a running context schedules two 880 Hz beeps, oscillator -> gain -> destination', () => {
  const Ctor = fakeAudioCtor();
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  assert.equal(alerts.chime(), true);
  const ctx = Ctor.instances[0];
  assert.equal(ctx.oscillators.length, 2);
  assert.equal(ctx.gains.length, 2);
  ctx.oscillators.forEach((osc, i) => {
    assert.equal(osc.frequency.value, 880);
    assert.equal(osc.startCalls.length, 1);
    assert.equal(osc.stopCalls.length, 1);
    assert.ok(osc.startCalls[0] >= ctx.currentTime + 0.02, 'starts with a small lookahead so the attack is never in the past');
    const dur = osc.stopCalls[0] - osc.startCalls[0];
    assert.ok(dur > 0.2 && dur <= 0.3, `beep lasts ~0.25 s, got ${dur}`);
    assert.deepEqual(osc.connected, [ctx.gains[i]]);
    assert.deepEqual(ctx.gains[i].connected, [ctx.destination]);
  });
  const [a, b] = ctx.oscillators;
  assert.ok(b.startCalls[0] >= a.stopCalls[0], 'second beep starts after the first ends');
  assert.ok(b.stopCalls[0] - ctx.currentTime <= 0.7, 'whole chime is ~0.6 s');
});

test('chime() ramps the gain in and back to 0 so the tone does not click', () => {
  const Ctor = fakeAudioCtor();
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  alerts.chime();
  const ctx = Ctor.instances[0];
  ctx.gains.forEach((g, i) => {
    const calls = g.gain.calls;
    const start = ctx.oscillators[i].startCalls[0];
    const stop = ctx.oscillators[i].stopCalls[0];
    assert.deepEqual(calls[0], ['set', 0, start]);
    const ramps = calls.filter((c) => c[0] === 'ramp');
    assert.equal(ramps.length, 2);
    assert.ok(ramps[0][1] > 0 && ramps[0][1] <= 1, 'ramps up to an audible but bounded level');
    assert.ok(ramps[0][2] > start && ramps[0][2] < stop, 'attack ends inside the beep');
    assert.equal(ramps[1][1], 0);
    assert.ok(ramps[1][2] <= stop, 'gain is back to 0 by the stop time');
  });
});

test('chime() can be called repeatedly on the same context', () => {
  const Ctor = fakeAudioCtor();
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  assert.equal(alerts.chime(), true);
  assert.equal(alerts.chime(), true);
  assert.equal(Ctor.instances.length, 1);
  assert.equal(Ctor.instances[0].oscillators.length, 4);
});

test('chime() returns false (never throws) when createOscillator throws', () => {
  const Ctor = fakeAudioCtor({ oscThrows: true });
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  assert.equal(alerts.chime(), false);
});

test('chime() returns false (never throws) when start() throws', () => {
  const Ctor = fakeAudioCtor();
  const alerts = createAlerts({ AudioContextCtor: Ctor });
  alerts.prime();
  const ctx = Ctor.instances[0];
  const original = ctx.createOscillator.bind(ctx);
  ctx.createOscillator = () => {
    const osc = original();
    osc.start = () => {
      throw new Error('start failed');
    };
    return osc;
  };
  assert.equal(alerts.chime(), false);
});

// ---------------------------------------------------------------- permission

test('permission() reflects granted / denied / default', () => {
  for (const p of ['granted', 'denied', 'default']) {
    const api = fakeNotificationApi({ permission: p });
    assert.equal(createAlerts({ NotificationApi: api.Ctor }).permission(), p);
  }
});

test("permission() is 'unsupported' without an API", () => {
  assert.equal(createAlerts({}).permission(), 'unsupported');
  assert.equal(createAlerts({ NotificationApi: undefined }).permission(), 'unsupported');
  assert.equal(createAlerts({ NotificationApi: null }).permission(), 'unsupported');
});

test("permission() is 'unsupported' for an API without a permission property or with a malformed value", () => {
  assert.equal(createAlerts({ NotificationApi: function Notification() {} }).permission(), 'unsupported');
  assert.equal(createAlerts({ NotificationApi: { permission: 'maybe' } }).permission(), 'unsupported');
  assert.equal(createAlerts({ NotificationApi: { permission: 42 } }).permission(), 'unsupported');
});

test("permission() is 'unsupported' when reading the property throws", () => {
  const api = {};
  Object.defineProperty(api, 'permission', {
    get() {
      throw new Error('blocked');
    },
  });
  assert.equal(createAlerts({ NotificationApi: api }).permission(), 'unsupported');
});

// ---------------------------------------------------------------- requestPermission

test('requestPermission() resolves granted (promise form)', async () => {
  const api = fakeNotificationApi({ mode: 'promise', result: 'granted' });
  const alerts = createAlerts({ NotificationApi: api.Ctor });
  assert.equal(await alerts.requestPermission(), 'granted');
  assert.equal(api.requestCalls, 1);
});

test('requestPermission() resolves denied (promise form)', async () => {
  const api = fakeNotificationApi({ mode: 'promise', result: 'denied' });
  assert.equal(await createAlerts({ NotificationApi: api.Ctor }).requestPermission(), 'denied');
});

test('requestPermission() resolves default when the prompt is dismissed', async () => {
  const api = fakeNotificationApi({ mode: 'promise', result: 'default' });
  assert.equal(await createAlerts({ NotificationApi: api.Ctor }).requestPermission(), 'default');
});

test('requestPermission() handles the legacy callback form', async () => {
  const api = fakeNotificationApi({ mode: 'legacy', result: 'granted' });
  assert.equal(await createAlerts({ NotificationApi: api.Ctor }).requestPermission(), 'granted');
  assert.equal(api.requestCalls, 1);
});

test('requestPermission() resolves the current permission when the call rejects', async () => {
  const api = fakeNotificationApi({ mode: 'reject', permission: 'default' });
  assert.equal(await createAlerts({ NotificationApi: api.Ctor }).requestPermission(), 'default');
});

test('requestPermission() resolves the current permission when the call throws', async () => {
  const api = fakeNotificationApi({ mode: 'throw', permission: 'denied' });
  assert.equal(await createAlerts({ NotificationApi: api.Ctor }).requestPermission(), 'denied');
});

test("requestPermission() resolves 'unsupported' without an API, and the current permission if the method is missing", async () => {
  assert.equal(await createAlerts({}).requestPermission(), 'unsupported');
  assert.equal(await createAlerts({ NotificationApi: { permission: 'default' } }).requestPermission(), 'default');
});

// ---------------------------------------------------------------- notify

test("notify() returns false and shows nothing when permission is 'default'", () => {
  const api = fakeNotificationApi({ permission: 'default' });
  assert.equal(createAlerts({ NotificationApi: api.Ctor }).notify('t', 'b'), false);
  assert.deepEqual(api.constructed, []);
});

test("notify() returns false and shows nothing when permission is 'denied'", () => {
  const api = fakeNotificationApi({ permission: 'denied' });
  assert.equal(createAlerts({ NotificationApi: api.Ctor }).notify('t', 'b'), false);
  assert.deepEqual(api.constructed, []);
});

test('notify() returns false when unsupported', () => {
  assert.equal(createAlerts({}).notify('t', 'b'), false);
});

test('notify() returns false (never throws) when the constructor throws', () => {
  function Throwing() {
    throw new TypeError('Illegal constructor');
  }
  Throwing.permission = 'granted';
  assert.equal(createAlerts({ NotificationApi: Throwing }).notify('t', 'b'), false);
});

test("notify() constructs with (title, { body }) and returns true when 'granted'", () => {
  const api = fakeNotificationApi({ permission: 'granted' });
  assert.equal(createAlerts({ NotificationApi: api.Ctor }).notify('Focus finito', 'Fai una pausa'), true);
  assert.deepEqual(api.constructed, [['Focus finito', { body: 'Fai una pausa', tag: 'focus-timer' }]]);
});

test('notify() reads the permission at call time, not at creation time', () => {
  const api = fakeNotificationApi({ permission: 'default' });
  const alerts = createAlerts({ NotificationApi: api.Ctor });
  assert.equal(alerts.notify('t', 'b'), false);
  api.permission = 'granted';
  assert.equal(alerts.notify('t', 'b'), true);
});

// ---------------------------------------------------------------- never prompts on its own

test('prime(), chime() and notify() never call requestPermission', () => {
  const api = fakeNotificationApi({ permission: 'default' });
  const alerts = createAlerts({ AudioContextCtor: fakeAudioCtor(), NotificationApi: api.Ctor });
  alerts.prime();
  alerts.chime();
  alerts.notify('t', 'b');
  api.permission = 'granted';
  alerts.notify('t', 'b');
  assert.equal(api.requestCalls, 0);
});

// ---- review fixes ----------------------------------------------------------

test('requestPermission() never rejects, even when reading requestPermission itself throws', async () => {
  const api = {
    get permission() { return 'default'; },
    get requestPermission() { throw new Error('blocked getter'); },
  };
  assert.equal(await createAlerts({ NotificationApi: api }).requestPermission(), 'default');
});

test('requestPermission() ignores a malformed resolved value and reports the current permission', async () => {
  const api = fakeNotificationApi({ permission: 'denied' });
  api.Ctor.requestPermission = () => Promise.resolve('maybe');
  assert.equal(await createAlerts({ NotificationApi: api.Ctor }).requestPermission(), 'denied');
});

test("prime() also resumes Safari's non-standard 'interrupted' state, but not 'closed'", () => {
  const interrupted = fakeAudioCtor({ initialState: 'interrupted' });
  createAlerts({ AudioContextCtor: interrupted }).prime();
  assert.equal(interrupted.instances[0].resumeCalls, 1);
  const closed = fakeAudioCtor({ initialState: 'closed' });
  createAlerts({ AudioContextCtor: closed }).prime();
  assert.equal(closed.instances[0].resumeCalls, 0);
});
