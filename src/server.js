// Entry point for `npm start`. Starts the API and closes Redis and MySQL cleanly on Ctrl+C.
const env = require('./config/env');
const healthModel = require('./models/healthModel');
const { closeQueues } = require('./services/queues');
const { createApp } = require('./app');

const app = createApp();

const server = app.listen(env.port, async () => {
  console.info(`MediBook API listening on http://localhost:${env.port}`);
  try {
    await healthModel.ping();
    console.info(`[mysql] connected to ${env.db.host}:${env.db.port}/${env.db.database}`);
  } catch (err) {
    console.warn(`[mysql] not reachable yet (${err.code || err.message}). Requests needing the DB will fail until it is up.`);
  }
});

function shutdown(signal) {
  console.info(`${signal} received, shutting down`);
  server.close(async () => {
    await closeQueues();
    await healthModel.closePool();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
