// The real waitlist store and processors, running against a fake in-memory Redis.
const { createWaitlistStore } = require('../src/utils/waitlistStore');
const { createSlotFreedProcessor } = require('../src/workers/processors/slotFreedProcessor');
const { createConfirmationProcessor } = require('../src/workers/processors/confirmationProcessor');
const { sweepWaitlists } = require('../src/workers/waitlistSweep');
const { buildEntry } = require('../src/utils/waitlistEntry');
const { parseClinicDateTime } = require('../src/utils/clock');
const { AUDIT_EVENT, BOOKING_OUTCOME } = require('../src/config/constants');

const SLOT = 'waitlist:doctor:2:slot:2027-05-03T10:00';
const DAY = 'waitlist:doctor:2:day:2027-05-03';
const FAILED = 'waitlist:failed';
const NOW = parseClinicDateTime('2027-05-01 12:00');

/** Only the list commands the store uses. waitlistJoin and waitlistMove copy what the Lua scripts do. */
function createFakeRedis() {
  const lists = new Map();
  const list = (key) => {
    if (!lists.has(key)) lists.set(key, []);
    return lists.get(key);
  };
  const cleanup = (key) => {
    if (lists.has(key) && lists.get(key).length === 0) lists.delete(key);
  };
  const lrem = (key, count, value) => {
    const items = list(key);
    const index = items.indexOf(value);
    if (index === -1) return 0;
    items.splice(index, 1);
    cleanup(key);
    return 1;
  };
  return {
    lists,
    defineCommand: jest.fn(),
    async scan(cursor, match, pattern) {
      const regex = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return ['0', [...lists.keys()].filter((key) => regex.test(key))];
    },
    async lrange(key) {
      return [...(lists.get(key) || [])];
    },
    async rpush(key, value) {
      return list(key).push(value);
    },
    async lmove(source, destination, from, to) {
      const items = lists.get(source);
      if (!items || items.length === 0) return null;
      const value = from === 'LEFT' ? items.shift() : items.pop();
      cleanup(source);
      if (to === 'LEFT') list(destination).unshift(value);
      else list(destination).push(value);
      return value;
    },
    async lrem(key, count, value) {
      return lrem(key, count, value);
    },
    async waitlistJoin(listKey, processing, patientId, raw) {
      const holds = (key) => (lists.get(key) || []).some((item) => String(JSON.parse(item).patientId) === patientId);
      if (holds(listKey) || holds(processing)) return -1;
      return list(listKey).push(raw);
    },
    async waitlistMove(source, target, raw, pushRaw, direction) {
      if (lrem(source, 1, raw) === 0) return 0;
      if (direction === 'front') list(target).unshift(pushRaw);
      else list(target).push(pushRaw);
      return 1;
    },
  };
}

function entry(patientId, type = 'slot') {
  return buildEntry({
    type, patientId, doctorId: 2, appointmentDateTime: '2027-05-03 10:00', joinedAt: `2026-11-2${patientId}T08:00:00.000Z`,
  });
}

function setup(scriptedResults = []) {
  const redis = createFakeRedis();
  const store = createWaitlistStore(redis);
  const audit = jest.fn(async () => {});
  const onAppointmentBooked = jest.fn(async () => {});
  const results = [...scriptedResults];
  const bookAppointment = jest.fn(async (request) => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    if (next.outcome === BOOKING_OUTCOME.BOOKED) {
      return { outcome: next.outcome, appointment: { id: 99, apptRef: 'AP-20270503-Y97V', patientId: request.patientId } };
    }
    return next;
  });
  const process = createSlotFreedProcessor({ store, bookAppointment, onAppointmentBooked, audit, now: () => NOW });
  const job = { id: '1', data: { doctorId: 2, appointmentDateTime: '2027-05-03 10:00', freedByAppointmentId: 7 } };
  const ids = (key) => (redis.lists.get(key) || []).map((raw) => JSON.parse(raw).patientId);
  const events = () => audit.mock.calls.map(([event]) => event);
  return { redis, store, audit, onAppointmentBooked, bookAppointment, process, job, ids, events };
}

describe('waitlist store: join', () => {
  test('FIFO positions and duplicate prevention (also against the processing list)', async () => {
    const { store, redis } = setup();
    expect(await store.join(SLOT, entry(1))).toBe(1);
    expect(await store.join(SLOT, entry(2))).toBe(2);
    expect(await store.join(SLOT, entry(1))).toBeNull();
    await redis.lmove(SLOT, `${SLOT}:processing`, 'LEFT', 'RIGHT');
    expect(await store.join(SLOT, entry(1))).toBeNull();
    expect(await store.join(DAY, entry(1, 'day'))).toBe(1);
  });
});

describe('slot-freed processor', () => {
  test('first patient fails permanently, second is booked', async () => {
    const t = setup([{ outcome: BOOKING_OUTCOME.PATIENT_DOUBLE_BOOKED }, { outcome: BOOKING_OUTCOME.BOOKED }]);
    await t.store.join(SLOT, entry(1));
    await t.store.join(SLOT, entry(2));
    await t.store.join(SLOT, entry(3));

    const result = await t.process(t.job);

    expect(result).toEqual({ promoted: true, appointmentId: 99, patientId: 2, fromList: 'slot' });
    expect(t.ids(SLOT)).toEqual([3]);
    expect(t.ids(`${SLOT}:processing`)).toEqual([]);
    const failed = t.redis.lists.get(FAILED).map((raw) => JSON.parse(raw));
    expect(failed).toEqual([expect.objectContaining({
      patientId: 1, reason: 'patient already has another appointment at that time', sourceList: SLOT,
    })]);
    expect(t.events()).toEqual([AUDIT_EVENT.WAITLIST_PROMOTION_FAILED, AUDIT_EVENT.WAITLIST_PROMOTED]);
    expect(t.audit.mock.calls[0][1]).toEqual(expect.objectContaining({ patientId: 1, permanent: true }));
    expect(t.audit.mock.calls[1][1]).toEqual(expect.objectContaining({
      appointmentId: 99, patientId: 2, fromList: 'slot', waitedSince: '2026-11-22T08:00:00.000Z',
    }));
    expect(t.onAppointmentBooked).toHaveBeenCalledWith(expect.objectContaining({ id: 99 }), { source: 'waitlist' });
    expect(t.bookAppointment.mock.calls[1][0]).toEqual(expect.objectContaining({
      patientId: 2, doctorId: 2, appointmentDateTime: '2027-05-03 10:00:00', amountPaid: undefined,
    }));
  });

  test('transient error: patient back at the FRONT, processor rethrows', async () => {
    const dbDown = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const t = setup([dbDown]);
    await t.store.join(SLOT, entry(1));
    await t.store.join(SLOT, entry(2));

    await expect(t.process(t.job)).rejects.toBe(dbDown);

    expect(t.ids(SLOT)).toEqual([1, 2]);
    expect(t.redis.lists.has(`${SLOT}:processing`)).toBe(false);
    expect(t.redis.lists.has(FAILED)).toBe(false);
    expect(t.audit).toHaveBeenCalledWith(AUDIT_EVENT.WAITLIST_PROMOTION_FAILED, expect.objectContaining({
      patientId: 1, permanent: false, reason: 'temporary error: ECONNREFUSED',
    }));
  });

  test('slot taken meanwhile: patient keeps first place, job stops', async () => {
    const t = setup([{ outcome: BOOKING_OUTCOME.SLOT_TAKEN }]);
    await t.store.join(SLOT, entry(1));
    await t.store.join(SLOT, entry(2));

    const result = await t.process(t.job);

    expect(result).toEqual(expect.objectContaining({ promoted: false, patientId: 1 }));
    expect(t.ids(SLOT)).toEqual([1, 2]);
    expect(t.bookAppointment).toHaveBeenCalledTimes(1);
    expect(t.audit).not.toHaveBeenCalled();
  });

  test('empty slot list -> the day list is used', async () => {
    const t = setup([{ outcome: BOOKING_OUTCOME.BOOKED }]);
    await t.store.join(DAY, entry(4, 'day'));

    const result = await t.process(t.job);

    expect(result).toEqual(expect.objectContaining({ promoted: true, patientId: 4, fromList: 'day' }));
    expect(t.redis.lists.size).toBe(0);
  });

  test('slot list exhausted by permanent failures -> continues with the day list', async () => {
    const t = setup([{ outcome: BOOKING_OUTCOME.PATIENT_NOT_FOUND }, { outcome: BOOKING_OUTCOME.BOOKED }]);
    await t.store.join(SLOT, entry(1));
    await t.store.join(DAY, entry(4, 'day'));

    expect(await t.process(t.job)).toEqual(expect.objectContaining({ promoted: true, patientId: 4, fromList: 'day' }));
    expect(t.ids(FAILED)).toEqual([1]);
  });

  test('both lists empty -> no-op', async () => {
    const t = setup();
    expect(await t.process(t.job)).toEqual({ promoted: false, reason: 'nobody is waiting for this slot or day' });
    expect(t.bookAppointment).not.toHaveBeenCalled();
  });

  test('freed slot already in the past: slot list fails, day list untouched', async () => {
    const t = setup();
    await t.store.join(SLOT, entry(1));
    await t.store.join(DAY, entry(4, 'day'));
    const pastJob = { data: { ...t.job.data, appointmentDateTime: '2027-04-30 10:00' } };
    await t.store.join('waitlist:doctor:2:slot:2027-04-30T10:00', entry(5));

    const result = await t.process(pastJob);

    expect(result).toEqual(expect.objectContaining({ promoted: false, failed: 1 }));
    expect(t.ids(FAILED)).toEqual([5]);
    expect(t.ids(DAY)).toEqual([4]);
    expect(t.bookAppointment).not.toHaveBeenCalled();
  });
});

describe('start-up recovery', () => {
  test('processing entries go back to the FRONT of their waitlist, oldest first', async () => {
    const { redis, store, ids } = setup();
    for (const id of [1, 2, 3, 4]) await store.join(SLOT, entry(id));
    await store.takeNext(SLOT); // 1 -> processing
    await store.takeNext(SLOT); // 2 -> processing
    await store.join(DAY, entry(5, 'day'));
    await store.takeNext(DAY);

    expect(await store.recoverProcessing()).toBe(3);
    expect(ids(SLOT)).toEqual([1, 2, 3, 4]);
    expect(ids(DAY)).toEqual([5]);
    expect([...redis.lists.keys()].some((key) => key.endsWith(':processing'))).toBe(false);
  });
});

describe('waitlist sweep', () => {
  test('queues a slot-freed job for a waitlisted slot that is actually free', async () => {
    const { store } = setup();
    await store.join(SLOT, entry(1));
    await store.join('waitlist:doctor:2:slot:2027-05-03T11:00', entry(2));
    const enqueueSlotFreed = jest.fn(async () => true);
    const findByDoctorBetween = jest.fn(async () => [{ appointmentDateTime: '2027-05-03 11:00', status: 'BOOKED' }]);

    const queued = await sweepWaitlists({ store, findByDoctorBetween, enqueueSlotFreed, now: () => NOW });

    expect(queued).toBe(1);
    expect(enqueueSlotFreed).toHaveBeenCalledWith({ doctorId: 2, appointmentDateTime: '2027-05-03 10:00', freedByAppointmentId: null });
    expect(findByDoctorBetween).toHaveBeenCalledWith(2, '2027-05-03 00:00:00', '2027-05-04 00:00:00');
  });
});

describe('send-confirmation processor', () => {
  test('builds the simulated SMS and audits NOTIFICATION_SENT', async () => {
    const audit = jest.fn(async () => {});
    const process = createConfirmationProcessor({ audit });
    const job = {
      id: '42',
      data: {
        appointmentId: 17, apptRef: 'AP-20270503-Y97V', patientId: 5, patientName: 'Abena Osei',
        doctorId: 2, doctorName: 'Dr. Efua Adjei', appointmentDateTime: '2027-05-03 10:00', amountPaid: 100, source: 'api',
      },
    };
    const message = 'SMS to patient 5 (Abena Osei): Your appointment AP-20270503-Y97V with Dr. Efua Adjei '
      + 'is confirmed for 2027-05-03 10:00. Amount paid: 100.00.';

    expect(await process(job)).toEqual({ message });
    expect(audit).toHaveBeenCalledWith(AUDIT_EVENT.NOTIFICATION_SENT, {
      appointmentId: 17, patientId: 5, channel: 'sms', message, jobId: '42',
    });
  });

  test('audit write fails -> the job rejects, so BullMQ retries instead of losing the message', async () => {
    const audit = jest.fn().mockRejectedValue(new Error('EISDIR'));
    const process = createConfirmationProcessor({ audit });
    const job = {
      id: '43',
      data: {
        appointmentId: 18, apptRef: 'AP-20270503-K7Q2', patientId: 6, patientName: 'Kwabena Addo',
        doctorId: 2, doctorName: 'Dr. Efua Adjei', appointmentDateTime: '2027-05-03 10:30', amountPaid: 100, source: 'api',
      },
    };
    await expect(process(job)).rejects.toThrow('EISDIR');
  });
});
