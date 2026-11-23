// Audit logger: real files in a temp dir (no MySQL/Redis), plus injected failing fs.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAuditLogger } = require('../src/services/auditLogger');
const { AUDIT_LOG } = require('../src/config/constants');

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONCURRENT_LOGS = 20;

let tempRoot;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'medibook-audit-'));
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function readLines(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  expect(content.endsWith('\n')).toBe(true);
  return content.trimEnd().split('\n').map((line) => JSON.parse(line));
}

describe('auditLogger: writing', () => {
  test('creates a missing nested log directory on the first log()', async () => {
    const dir = path.join(tempRoot, 'missing', 'nested');
    const logger = createAuditLogger({ dir });
    await logger.log('APPOINTMENT_BOOKED', { appointmentId: 1 });
    expect(logger.filePath).toBe(path.join(dir, AUDIT_LOG.FILE_NAME));
    await expect(fs.stat(logger.filePath)).resolves.toBeDefined();
  });

  test('two log() calls -> exactly two JSON lines with timestamp, event and payload', async () => {
    const logger = createAuditLogger({ dir: path.join(tempRoot, 'two-lines') });
    await logger.log('APPOINTMENT_BOOKED', { appointmentId: 7, doctorId: 2, source: 'api' });
    await logger.log('APPOINTMENT_CANCELLED', { appointmentId: 7, refundPercent: 50, refundAmount: 75 });

    const lines = await readLines(logger.filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      timestamp: expect.stringMatching(ISO_TIMESTAMP),
      event: 'APPOINTMENT_BOOKED',
      appointmentId: 7,
      doctorId: 2,
      source: 'api',
    });
    expect(lines[1]).toMatchObject({ event: 'APPOINTMENT_CANCELLED', refundPercent: 50, refundAmount: 75 });
    expect(lines[1].timestamp).toMatch(ISO_TIMESTAMP);
  });

  test('a log() with no payload still writes timestamp and event', async () => {
    const logger = createAuditLogger({ dir: path.join(tempRoot, 'no-payload') });
    await logger.log('NOTIFICATION_SENT');
    const [line] = await readLines(logger.filePath);
    expect(Object.keys(line)).toEqual(['timestamp', 'event']);
  });

  test(`${CONCURRENT_LOGS} concurrent log() calls -> ${CONCURRENT_LOGS} complete JSON lines`, async () => {
    const logger = createAuditLogger({ dir: path.join(tempRoot, 'concurrent', 'deep') });
    const ids = Array.from({ length: CONCURRENT_LOGS }, (_, i) => i + 1);
    await Promise.all(ids.map((id) => logger.log('WAITLIST_JOINED', { patientId: id })));

    const lines = await readLines(logger.filePath);
    expect(lines).toHaveLength(CONCURRENT_LOGS);
    expect(lines.map((l) => l.patientId).sort((a, b) => a - b)).toEqual(ids);
  });
});

describe('auditLogger: failures never throw', () => {
  let consoleError;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test('appendFile rejecting -> log() resolves and console.error is called', async () => {
    const failingFs = {
      mkdir: jest.fn().mockResolvedValue(undefined),
      appendFile: jest.fn().mockRejectedValue(new Error('disk full')),
    };
    const logger = createAuditLogger({ dir: path.join(tempRoot, 'unused'), fs: failingFs });

    await expect(logger.log('APPOINTMENT_BOOKED', { appointmentId: 1 })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toContain('disk full');
  });

  test('mkdir rejecting -> log() resolves, and the next call retries mkdir', async () => {
    const failingFs = {
      mkdir: jest.fn()
        .mockRejectedValueOnce(new Error('permission denied'))
        .mockResolvedValue(undefined),
      appendFile: jest.fn().mockResolvedValue(undefined),
    };
    const logger = createAuditLogger({ dir: path.join(tempRoot, 'unused'), fs: failingFs });

    await expect(logger.log('APPOINTMENT_BOOKED')).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(failingFs.appendFile).not.toHaveBeenCalled();

    await logger.log('APPOINTMENT_BOOKED');
    expect(failingFs.mkdir).toHaveBeenCalledTimes(2);
    expect(failingFs.appendFile).toHaveBeenCalledTimes(1);
  });

  test('strict mode: the failure is printed AND rejected (so a queue job can retry)', async () => {
    const failingFs = {
      mkdir: jest.fn().mockResolvedValue(undefined),
      appendFile: jest.fn().mockRejectedValue(new Error('EISDIR')),
    };
    const logger = createAuditLogger({ dir: path.join(tempRoot, 'unused'), fs: failingFs });

    await expect(logger.log('NOTIFICATION_SENT', { appointmentId: 1 }, { strict: true }))
      .rejects.toThrow('EISDIR');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('strict mode writes normally when nothing fails', async () => {
    const logger = createAuditLogger({ dir: path.join(tempRoot, 'strict-ok') });
    await expect(logger.log('NOTIFICATION_SENT', { appointmentId: 2 }, { strict: true })).resolves.toBeUndefined();
    const [line] = await readLines(logger.filePath);
    expect(line).toMatchObject({ event: 'NOTIFICATION_SENT', appointmentId: 2 });
  });

  test('mkdir runs only once when it succeeds', async () => {
    const fakeFs = {
      mkdir: jest.fn().mockResolvedValue(undefined),
      appendFile: jest.fn().mockResolvedValue(undefined),
    };
    const logger = createAuditLogger({ dir: path.join(tempRoot, 'unused'), fs: fakeFs });
    await Promise.all([logger.log('A'), logger.log('B'), logger.log('C')]);
    expect(fakeFs.mkdir).toHaveBeenCalledTimes(1);
    expect(fakeFs.appendFile).toHaveBeenCalledTimes(3);
  });
});
