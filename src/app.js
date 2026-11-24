// Builds the Express app but doesn't start listening. server.js does that,
// which keeps the app importable on its own.
const express = require('express');
const healthRoutes = require('./routes/healthRoutes');
const patientRoutes = require('./routes/patientRoutes');
const doctorRoutes = require('./routes/doctorRoutes');
const statisticsRoutes = require('./routes/statisticsRoutes');
const waitlistRoutes = require('./routes/waitlistRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const reportRoutes = require('./routes/reportRoutes');
const feedbackRoutes = require('./routes/feedbackRoutes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRoutes);
  app.use('/api/patients', patientRoutes);
  // These two routers read the doctor :id from the mount path (mergeParams).
  app.use('/api/doctors/:id/statistics', statisticsRoutes);
  app.use('/api/doctors/:id/waitlist', waitlistRoutes);
  app.use('/api/doctors', doctorRoutes);
  app.use('/api/appointments', appointmentRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/feedback', feedbackRoutes);

  // The 404 handler has to come after every route, and the error handler last of all.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
