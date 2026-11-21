const healthModel = require('../models/healthModel');

/** GET /api/health: reports whether the API can reach MySQL. */
async function getHealth(req, res) {
  let database = 'up';
  try {
    await healthModel.ping();
  } catch {
    database = 'down';
  }
  const healthy = database === 'up';
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', database });
}

module.exports = { getHealth };
