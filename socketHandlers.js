// socketHandlers.js
//
// All Socket.io event wiring lives here. index.js just calls
// registerSocketHandlers(io) once at startup.

const {
  createRoom,
  joinRoom,
  findRoomBySocket,
  getPeerId,
  updatePlaybackState,
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
        ack({ ok: true, code: room.code });
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
      console.log(`[join-room] ${socket.id} joined room ${code}`);

      const room = result.room;
      const peerId = getPeerId(room, socket.id);

      // Tell the joining client the room's current playback state so it
      // can resync immediately instead of waiting for the next event.
      if (typeof ack === 'function') {
        ack({ ok: true, code: room.code, playbackState: room.playbackState });
      }

      // Let the existing member know someone joined.
      if (peerId) {
        io.to(peerId).emit('peer-joined', { socketId: socket.id });
      }
    });

    // --- Playback event relaying ------------------------------------------

    PLAYBACK_EVENTS.forEach((eventType) => {
      socket.on(eventType, (payload = {}) => {
        const room = findRoomBySocket(socket.id);
        if (!room) return; // not in a room — ignore

        updatePlaybackState(room, eventType, payload.currentTime);

        const peerId = getPeerId(room, socket.id);
        if (!peerId) return; // no partner yet, nothing to relay to

        io.to(peerId).emit(eventType, {
          currentTime: payload.currentTime,
          // Server-authoritative timestamp, so the receiver can measure
          // delivery latency and compensate (e.g. seek forward on play).
          serverTimestamp: Date.now(),
        });
      });
    });

    // --- Disconnect handling ----------------------------------------------

    socket.on('disconnect', (reason) => {
      console.log(`[disconnect] ${socket.id} (${reason})`);

      // removeSocket() takes the disconnecting socket OUT of the room
      // first, so anyone left in room.members afterward is the peer.
      const room = removeSocket(socket.id);
      if (!room) return;

      const remainingPeerId = [...room.members][0];
      if (remainingPeerId) {
        io.to(remainingPeerId).emit('peer-disconnected', { socketId: socket.id });
      }
    });
  });
}

module.exports = { registerSocketHandlers };
