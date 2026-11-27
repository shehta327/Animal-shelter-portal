// Animal Listings service - the Express app (used by server.js and lambda.js).
require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const { requestLogger, securityHeaders, jsonOnly, bodyFix } = require('./lib/middleware');
const { notFoundRoute, errorHandler } = require('./lib/http');
const animalRoutes = require('./routes/animals');

const app = express();
app.disable('x-powered-by');
app.use(requestLogger);
app.use(cors({
  origin: (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map((o) => o.trim()),
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  exposedHeaders: ['Location', 'X-Request-Id'],
  maxAge: 600
}));
app.use(securityHeaders);
app.use(jsonOnly);
app.use(express.json({ limit: '20kb' }));
app.use(bodyFix);

app.get('/api/health/animals', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'animals',
    runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'pc',
    environment: process.env.NODE_ENV || 'development'
  });
});

app.use('/api/animals', animalRoutes);
app.use(notFoundRoute);
app.use(errorHandler);

module.exports = app;
