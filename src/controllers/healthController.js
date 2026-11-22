const healthModel = require('../models/healthModel');
const { HTTP_STATUS } = require('../config/constants');

/** GET /api/health: reports whether the API can reach MySQL. */
async function getHealth(req, res) {
  let database = 'up';
  try {
    await healthModel.ping();
  } catch {
    database = 'down';
  }
  const healthy = database === 'up';
  res.status(healthy ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE).json({ status: healthy ? 'ok' : 'degraded', database });
}

module.exports = { getHealth };
