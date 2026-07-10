// index.js
//
// Server entry point. Sets up a minimal Express app (mostly just for a
// health-check route) plus a Socket.io server attached to the same HTTP
// server, and wires up room/event handling from socketHandlers.js.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { registerSocketHandlers } = require('./socketHandlers');

const PORT = process.env.PORT || 3001;

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    // Loosened for local development. Lock this down to your actual
    // client origin(s) before deploying publicly.
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

registerSocketHandlers(io);

httpServer.listen(PORT, () => {
  console.log(`SyncWatch server listening on port ${PORT}`);
});
