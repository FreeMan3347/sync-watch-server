// socketHandlers.js
//
// All Socket.io event wiring lives here. index.js just calls
// registerSocketHandlers(io) once at startup.
//
// Rooms now support up to MAX_MEMBERS_PER_ROOM people (see rooms.js),
// not just two. Instead of manually tracking "the other person's socket
// id" and unicasting to them, we use Socket.io's own room broadcast —
// socket.to(code).emit(...) sends to everyone in that room except the
// sender, automatically, regardless of how many people are in it.

const {
  createRoom,
  joinRoom,
  findRoomBySocket,
  updatePlaybackState,
  updatePlaybackTime,
  removeSocket,
} = require('./rooms');

const PLAYBACK_EVENTS = ['play', 'pause', 'seek'];

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);

    // --- Room creation --------------------------------------------------

    socket.on('create-room', (_payload, ack) => {
      const room = createRoom(socket.id);
      socket.join(room.code);

      console.log(`[create-room] ${socket.id} created room ${room.code}`);

      if (typeof ack === 'function') {
        ack({ ok: true, code: room.code, memberCount: room.members.size });
      }
    });

    // --- Room joining ----------------------------------------------------

    socket.on('join-room', (payload, ack) => {
      const code = (payload?.code || '').toUpperCase().trim();
      const result = joinRoom(code, socket.id);

      if (!result.ok) {
        console.log(`[join-room] ${socket.id} failed to join ${code}: ${result.reason}`);
        if (typeof ack === 'function') {
          ack({ ok: false, reason: result.reason });
        }
        return;
      }

      socket.join(code);
      console.log(`[join-room] ${socket.id} joined room ${code} (${result.room.members.size}/${result.room.members.size} shown after join)`);

      const room = result.room;

      // Tell the joining client the room's current playback state so it
      // can resync immediately instead of waiting for the next event.
      if (typeof ack === 'function') {
        ack({
          ok: true,
          code: room.code,
          playbackState: room.playbackState,
          memberCount: room.members.size,
        });
      }

      // Let everyone already in the room know someone new joined.
      socket.to(code).emit('peer-joined', {
        socketId: socket.id,
        memberCount: room.members.size,
      });
    });

    // --- Playback event relaying ------------------------------------------

    PLAYBACK_EVENTS.forEach((eventType) => {
      socket.on(eventType, (payload = {}) => {
        const room = findRoomBySocket(socket.id);
        if (!room) return; // not in a room — ignore

        updatePlaybackState(room, eventType, payload.currentTime);

        socket.to(room.code).emit(eventType, {
          currentTime: payload.currentTime,
          // Server-authoritative timestamp, so each receiver can measure
          // delivery latency and compensate (e.g. seek forward on play).
          serverTimestamp: Date.now(),
        });
      });
    });

    // --- Drift-correction heartbeats ---------------------------------------
    //
    // Sent periodically by a client while playing (not on every event —
    // just a steady "here's roughly where I am"). Broadcast to the rest
    // of the room the same way play/pause/seek are, so everyone else can
    // nudge themselves back in sync if they've drifted more than a small
    // tolerance. Unlike play/pause/seek, this does NOT change the room's
    // known play/pause state — only the currentTime.

    socket.on('heartbeat', (payload = {}) => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;

      updatePlaybackTime(room, payload.currentTime);

      socket.to(room.code).emit('heartbeat', {
        currentTime: payload.currentTime,
        serverTimestamp: Date.now(),
      });
    });

    // --- Chat message relaying ----------------------------------------------

    socket.on('chat-message', (payload = {}) => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;

      socket.to(room.code).emit('chat-message', {
        text: payload.text,
        senderId: socket.id,
        timestamp: Date.now(),
      });
    });

    // --- Disconnect handling ----------------------------------------------

    socket.on('disconnect', (reason) => {
      console.log(`[disconnect] ${socket.id} (${reason})`);

      const room = removeSocket(socket.id);
      if (!room) return;

      // Room broadcast (not socket.to, since the disconnecting socket is
      // already gone and can't receive this anyway) to whoever remains.
      io.to(room.code).emit('peer-disconnected', {
        socketId: socket.id,
        memberCount: room.members.size,
      });
    });
  });
}

module.exports = { registerSocketHandlers };
