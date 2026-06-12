const express = require('express');
const packageJson = require('../package.json');

const app = express();

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'DevOps Playground API is running',
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: packageJson.name,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/version', (req, res) => {
  res.status(200).json({
    name: packageJson.name,
    version: packageJson.version,
    environment: process.env.NODE_ENV || 'development',
  });
});

module.exports = app;
