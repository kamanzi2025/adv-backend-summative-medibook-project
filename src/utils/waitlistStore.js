// Every Redis command the waitlist uses, in one place. The Redis client is
// injected (this module imports no connection), so the web server, the worker and
// the unit tests (with an in-memory fake client) all share the same code.
//
// Lists are FIFO: RPUSH to join, LMOVE <list> <processing> LEFT RIGHT to take the
// oldest waiting patient (reliable pop: the entry is never only in memory).
const { WAITLIST_KEYS } = require('../config/constants');
const { processingKey, processingKeyPattern, parseWaitlistKey } = require('./waitlistKeys');

// SCAN hint: how many keys Redis looks at per call.
const SCAN_BATCH = 100;

// KEYS[1] waiting list, KEYS[2] its processing list, ARGV[1] patientId, ARGV[2] entry JSON.
// Atomic "join unless already there": returns the new length (= position) or -1.
const JOIN_SCRIPT = `
local function holds(key)
  for _, raw in ipairs(redis.call('LRANGE', key, 0, -1)) do
    local ok, entry = pcall(cjson.decode, raw)
    if ok and type(entry) == 'table' and tostring(entry.patientId) == ARGV[1] then
      return true
    end
  end
  return false
end
if holds(KEYS[1]) or holds(KEYS[2]) then return -1 end
return redis.call('RPUSH', KEYS[1], ARGV[2])
`;

// KEYS[1] source list, KEYS[2] target list, ARGV[1] JSON to remove from the source,
// ARGV[2] JSON to push to the target, ARGV[3] 'front' (LPUSH) or 'back' (RPUSH).
// Atomic move: pushes only if the entry was really removed, so it can never duplicate.
const MOVE_SCRIPT = `
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 0 then return 0 end
if ARGV[3] == 'front' then
  redis.call('LPUSH', KEYS[2], ARGV[2])
else
  redis.call('RPUSH', KEYS[2], ARGV[2])
end
return 1
`;

const DUPLICATE = -1;

function defineCommands(redis) {
  if (typeof redis.waitlistJoin !== 'function') {
    redis.defineCommand('waitlistJoin', { numberOfKeys: 2, lua: JOIN_SCRIPT });
  }
  if (typeof redis.waitlistMove !== 'function') {
    redis.defineCommand('waitlistMove', { numberOfKeys: 2, lua: MOVE_SCRIPT });
  }
}

/**
 * @param {import('ioredis').Redis} redis
 */
function createWaitlistStore(redis) {
  defineCommands(redis);

  /** Every key matching a glob pattern (SCAN, never KEYS). */
  async function scanKeys(pattern) {
    const keys = new Set();
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
      batch.forEach((key) => keys.add(key));
      cursor = next;
    } while (cursor !== '0');
    return [...keys];
  }

  return {
    scanKeys,

    /** Every raw JSON string in a list, oldest first. */
    readList(key) {
      return redis.lrange(key, 0, -1);
    },

    /**
     * Appends the entry unless the patient is already in the list or its processing list.
     * @returns {Promise<number|null>} 1-based position, or null for a duplicate
     */
    async join(listKey, entry) {
      const length = await redis.waitlistJoin(
        listKey, processingKey(listKey), String(entry.patientId), JSON.stringify(entry),
      );
      return length === DUPLICATE ? null : length;
    },

    /** Moves the oldest waiting entry into the processing list. @returns raw JSON or null */
    takeNext(listKey) {
      return redis.lmove(listKey, processingKey(listKey), 'LEFT', 'RIGHT');
    },

    /** The promotion committed: forget the entry. */
    complete(listKey, raw) {
      return redis.lrem(processingKey(listKey), 1, raw);
    },

    /** Not this patient's fault: back to the FRONT of the waiting list. */
    returnToFront(listKey, raw) {
      return redis.waitlistMove(processingKey(listKey), listKey, raw, raw, 'front');
    },

    /** Permanent failure: processing -> WAITLIST_KEYS.FAILED with the reason. */
    markFailed(listKey, raw, failedEntry) {
      return redis.waitlistMove(
        processingKey(listKey), WAITLIST_KEYS.FAILED, raw, JSON.stringify(failedEntry), 'back',
      );
    },

    /**
     * Startup recovery after a crash between LMOVE and LREM: every processing list is
     * moved back to the FRONT of its waiting list. LMOVE ... RIGHT LEFT takes the
     * newest processing entry first, so the oldest ends up first, as before.
     * @returns {Promise<number>} how many entries were recovered
     */
    async recoverProcessing() {
      let recovered = 0;
      for (const key of await scanKeys(processingKeyPattern())) {
        const parts = parseWaitlistKey(key);
        if (parts && parts.processing) {
          while (await redis.lmove(key, parts.listKey, 'RIGHT', 'LEFT') !== null) recovered += 1;
        }
      }
      return recovered;
    },
  };
}

module.exports = { createWaitlistStore };
