// socketHandlers.js
//
// All Socket.io event wiring lives here. index.js just calls
// registerSocketHandlers(io) once at startup.
//
// Rooms broadcast to everyone in them (up to MAX_MEMBERS_PER_ROOM, see
// rooms.js) via socket.to(code).emit(...), Socket.io's built-in room
// broadcast — no manual peer-tracking needed. Each member also has a
// nickname now, so joins/leaves/chat can say WHO, not just THAT
// something happened.

const {
  createRoom,
  joinRoom,
  findRoomBySocket,
  getRoster,
  getNickname,
  updatePlaybackState,
  updatePlaybackTime,
  addVoiceMember,
  removeVoiceMember,
  getVoiceRoster,
  removeSocket,
} = require('./rooms');

const PLAYBACK_EVENTS = ['play', 'pause', 'seek'];

function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);

    // --- Room creation --------------------------------------------------

    socket.on('create-room', (payload = {}, ack) => {
      const room = createRoom(socket.id, payload.nickname);
      socket.join(room.code);

      console.log(`[create-room] ${socket.id} created room ${room.code}`);

      if (typeof ack === 'function') {
        ack({ ok: true, code: room.code, roster: getRoster(room) });
      }
    });

    // --- Room joining ----------------------------------------------------

    socket.on('join-room', (payload, ack) => {
      const code = (payload?.code || '').toUpperCase().trim();
      const result = joinRoom(code, socket.id, payload?.nickname);

      if (!result.ok) {
        console.log(`[join-room] ${socket.id} failed to join ${code}: ${result.reason}`);
        if (typeof ack === 'function') {
          ack({ ok: false, reason: result.reason });
        }
        return;
      }

      socket.join(code);
      const room = result.room;
      console.log(`[join-room] ${socket.id} joined room ${code}`);

      if (typeof ack === 'function') {
        ack({
          ok: true,
          code: room.code,
          playbackState: room.playbackState,
          roster: getRoster(room),
        });
      }

      // Let everyone already in the room know who joined, with the
      // full updated roster so their member lists stay in sync.
      socket.to(code).emit('peer-joined', {
        socketId: socket.id,
        nickname: getNickname(room, socket.id),
        roster: getRoster(room),
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
        nickname: getNickname(room, socket.id),
        timestamp: Date.now(),
      });
    });

    // --- Voice call ---------------------------------------------------------
    //
    // Capped at MAX_VOICE_MEMBERS (4) — this is a mesh WebRTC setup (every
    // participant connects directly to every other one), which doesn't
    // scale past a handful of people without a dedicated media relay
    // server, which isn't in budget. Room membership can still be up to
    // 10; voice is a separate, smaller roster within that.
    //
    // The server's only job here is bookkeeping (who's in voice) and
    // relaying WebRTC signaling messages (offer/answer/ICE candidates)
    // between specific peers — it never touches the actual audio, that
    // goes directly between browsers once connected.

    socket.on('voice-join', (_payload, ack) => {
      const room = findRoomBySocket(socket.id);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, reason: 'NO_ROOM' });
        return;
      }

      const gotSeat = addVoiceMember(room, socket.id);
      if (!gotSeat) {
        if (typeof ack === 'function') ack({ ok: false, reason: 'VOICE_FULL' });
        return;
      }

      // Tell the joiner who's already in the call — they'll be the one
      // to initiate a WebRTC offer to each existing member, so both
      // sides never try to start the connection at the same time.
      const existingMembers = getVoiceRoster(room).filter((m) => m.socketId !== socket.id);
      if (typeof ack === 'function') ack({ ok: true, existingMembers });

      socket.to(room.code).emit('voice-roster', getVoiceRoster(room));
    });

    socket.on('voice-leave', () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;

      removeVoiceMember(room, socket.id);
      io.to(room.code).emit('voice-roster', getVoiceRoster(room));
    });

    // Relays an SDP offer/answer or ICE candidate to one specific peer —
    // not a room broadcast, since WebRTC signaling is always point-to-point.
    socket.on('voice-signal', (payload = {}) => {
      if (!payload.to) return;
      io.to(payload.to).emit('voice-signal', { from: socket.id, data: payload.data });
    });

    // Voice is full — this lets someone flag "I want in" without an
    // actual queue. Whoever's currently in voice sees it and can choose
    // to leave, freeing a seat for the buzzing person to join normally.
    socket.on('voice-buzz', () => {
      const room = findRoomBySocket(socket.id);
      if (!room) return;
      socket.to(room.code).emit('voice-buzz', { nickname: getNickname(room, socket.id) });
    });

    // --- Disconnect handling ----------------------------------------------

    socket.on('disconnect', (reason) => {
      console.log(`[disconnect] ${socket.id} (${reason})`);

      const leavingNickname = (() => {
        const room = findRoomBySocket(socket.id);
        return room ? getNickname(room, socket.id) : 'Guest';
      })();

      const room = removeSocket(socket.id);
      if (!room) return;

      io.to(room.code).emit('peer-disconnected', {
        socketId: socket.id,
        nickname: leavingNickname,
        roster: getRoster(room),
      });

      // removeSocket() already dropped them from voiceMembers internally —
      // just let the room know the voice roster changed too.
      io.to(room.code).emit('voice-roster', getVoiceRoster(room));
    });
  });
}

module.exports = { registerSocketHandlers };
