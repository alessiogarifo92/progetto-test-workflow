// Persistence layer: safe JSON storage on top of a localStorage-like backing.
// Knows nothing about the domain shape (that belongs to the core) and never throws.
// No module-level access to window/document: the backing is injected.

export const NAMESPACE = 'focusTimer';
export const VERSION = 1;

const NAMES = ['state', 'settings'];

export function storageKey(name, version = VERSION) {
  return `${NAMESPACE}:v${version}:${name}`;
}

// Reading the localStorage property itself can throw (SecurityError when storage is blocked).
export function getLocalStorage(globalObj = globalThis) {
  try {
    return globalObj.localStorage ?? null;
  } catch {
    return null;
  }
}

function parse(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createStore(backing, options = {}) {
  const { version = VERSION, migrations = {} } = options;
  let memory = backing ? null : new Map();

  function fallToMemory() {
    if (!memory) memory = new Map();
  }

  // Raw string or null. A throwing backing switches the store to memory for good.
  function readRaw(key) {
    if (memory) return memory.has(key) ? memory.get(key) : null;
    try {
      const raw = backing.getItem(key);
      return raw === undefined ? null : raw;
    } catch {
      fallToMemory();
      return null;
    }
  }

  // True if persisted to the backing storage, false if kept in memory.
  function writeRaw(key, raw) {
    if (!memory) {
      try {
        backing.setItem(key, raw);
        return true;
      } catch {
        fallToMemory();
      }
    }
    memory.set(key, raw);
    return false;
  }

  function migrate(name) {
    for (let from = version - 1; from >= 0; from--) {
      if (readRaw(storageKey(name, from)) === null) continue;
      let data = {};
      for (const n of NAMES) data[n] = parse(readRaw(storageKey(n, from)));
      for (let step = from; step < version; step++) {
        const fn = migrations[step];
        if (typeof fn === 'function') data = fn(data);
      }
      const result = data?.[name] ?? null;
      if (result !== null) writeRaw(storageKey(name, version), JSON.stringify(result));
      return result;
    }
    return null;
  }

  function load(name) {
    try {
      const raw = readRaw(storageKey(name, version));
      if (raw !== null) return parse(raw);
      return migrate(name);
    } catch {
      return null;
    }
  }

  function save(name, value) {
    let raw;
    try {
      raw = JSON.stringify(value);
    } catch {
      return false; // circular, BigInt, throwing toJSON...
    }
    if (typeof raw !== 'string') return false; // undefined, functions, symbols
    return writeRaw(storageKey(name, version), raw);
  }

  return {
    loadState: () => load('state'),
    saveState: (value) => save('state', value),
    loadSettings: () => load('settings'),
    saveSettings: (value) => save('settings', value),
    isPersistent: () => memory === null,
  };
}
