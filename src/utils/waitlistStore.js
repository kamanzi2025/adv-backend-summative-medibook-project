// Every Redis command the waitlist uses, in one place. The Redis client is passed
// in rather than imported, so the web server, the worker and the tests (with an
// in-memory fake) all run the same code.
//
// The lists are FIFO: RPUSH to join, and LMOVE <list> <processing> LEFT RIGHT to take
// the patient who has waited longest. LMOVE moves the entry instead of popping it, so
// it's always stored somewhere in Redis and a crash can't lose it.
const { WAITLIST_KEYS } = require('../config/constants');
const { processingKey, processingKeyPattern, parseWaitlistKey } = require('./waitlistKeys');

// How many keys Redis checks per SCAN call (a hint, not a limit).
const SCAN_BATCH = 100;

// KEYS[1] waiting list, KEYS[2] its processing list, ARGV[1] patientId, ARGV[2] entry JSON.
// "Join unless already on the list", done atomically in Lua. Returns the new length
// (which is the position) or -1.
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
// It only pushes if the remove actually found the entry, so an entry can't end up twice.
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

  /** Every key matching a pattern. Uses SCAN, never KEYS, so Redis isn't blocked. */
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

    /** All the raw JSON strings in a list, oldest first. */
    readList(key) {
      return redis.lrange(key, 0, -1);
    },

    /**
     * Adds the entry unless the patient is already on this list or its processing list.
     * @returns {Promise<number|null>} position starting at 1, or null if it's a duplicate
     */
    async join(listKey, entry) {
      const length = await redis.waitlistJoin(
        listKey, processingKey(listKey), String(entry.patientId), JSON.stringify(entry),
      );
      return length === DUPLICATE ? null : length;
    },

    /** Moves the longest-waiting entry into the processing list. @returns raw JSON or null */
    takeNext(listKey) {
      return redis.lmove(listKey, processingKey(listKey), 'LEFT', 'RIGHT');
    },

    /** The promotion has committed, so the entry can go. */
    complete(listKey, raw) {
      return redis.lrem(processingKey(listKey), 1, raw);
    },

    /** Not the patient's fault, so they go back to the front of the waiting list. */
    returnToFront(listKey, raw) {
      return redis.waitlistMove(processingKey(listKey), listKey, raw, raw, 'front');
    },

    /** Permanent failure: from processing to WAITLIST_KEYS.FAILED, with the reason. */
    markFailed(listKey, raw, failedEntry) {
      return redis.waitlistMove(
        processingKey(listKey), WAITLIST_KEYS.FAILED, raw, JSON.stringify(failedEntry), 'back',
      );
    },

    /**
     * Start-up recovery after a crash between LMOVE and LREM: everything left in a
     * processing list goes back to the front of its waiting list. LMOVE ... RIGHT LEFT
     * takes the newest entry first, so the oldest one ends up first again, as before.
     * @returns {Promise<number>} how many entries were put back
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
