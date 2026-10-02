// Alerts: a generated chime (WebAudio) and an opt-in system notification.
// Both browser APIs are injected: no module-level access to window/document, nothing runs
// at import time, and no method ever throws. Whether an alert is due at all (the 60 s
// grace rule) is the core's call (`shouldAlert`), not this module's.

const PERMISSIONS = ['granted', 'denied', 'default'];

const FREQUENCY_HZ = 880;
const BEEPS = 2;
const BEEP_S = 0.25;
const GAP_S = 0.1;
const PEAK_GAIN = 0.3;
const ATTACK_S = 0.02;
const LOOKAHEAD_S = 0.02;
const NOTIFICATION_TAG = 'focus-timer'; // collapses repeats (two tabs, several sessions) in the OS centre

const isPermission = (value) => PERMISSIONS.includes(value);

export function createAlerts({ AudioContextCtor, NotificationApi } = {}) {
  let ctx = null;

  // Call inside the Start click handler: browsers only let an AudioContext run (or resume)
  // after a user gesture. Lazy, idempotent, and a failure just leaves the chime disabled.
  function prime() {
    try {
      if (!ctx) {
        if (typeof AudioContextCtor !== 'function') return;
        ctx = new AudioContextCtor();
      }
      if (ctx.state !== 'running' && ctx.state !== 'closed') { // 'suspended', or Safari's 'interrupted'
        const pending = ctx.resume();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      }
    } catch {
      // no audio: chime() stays false
    }
  }

  // Two short beeps with a quick gain ramp in and out (no click). Plays only on a running
  // context; a suspended one (autoplay policy) would queue the tone and play it late.
  function chime() {
    try {
      if (!ctx || ctx.state !== 'running') return false;
      const t0 = ctx.currentTime + LOOKAHEAD_S; // never schedule in the past: the attack would click
      for (let i = 0; i < BEEPS; i += 1) {
        const start = t0 + i * (BEEP_S + GAP_S);
        const stop = start + BEEP_S;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = FREQUENCY_HZ;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + ATTACK_S);
        gain.gain.linearRampToValueAtTime(0, stop);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(stop);
      }
      return true;
    } catch {
      return false;
    }
  }

  function permission() {
    try {
      const value = NotificationApi ? NotificationApi.permission : undefined;
      return isPermission(value) ? value : 'unsupported';
    } catch {
      return 'unsupported';
    }
  }

  // Call ONLY from the toggle's click handler. Always resolves, never rejects.
  function requestPermission() {
    return new Promise((resolve) => {
      const settle = (value) => resolve(isPermission(value) ? value : permission());
      const fallback = () => resolve(permission());
      try {
        if (!NotificationApi || typeof NotificationApi.requestPermission !== 'function') {
          fallback();
          return;
        }
        // Promise form, or legacy callback form (returns undefined, calls the callback).
        const result = NotificationApi.requestPermission(settle);
        if (result && typeof result.then === 'function') result.then(settle, fallback);
      } catch {
        fallback();
      }
    });
  }

  // Never prompts: 'default' behaves like 'denied'.
  function notify(title, body) {
    try {
      if (permission() !== 'granted') return false;
      new NotificationApi(title, { body, tag: NOTIFICATION_TAG });
      return true;
    } catch {
      return false;
    }
  }

  return { prime, chime, permission, requestPermission, notify };
}
