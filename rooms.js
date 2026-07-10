// rooms.js
//
// In-memory room state. No database — rooms live only as long as the
// server process does, which is fine for a lightweight sync-watch app.
// If you need rooms to survive a server restart later, this is the file
// to swap out for a Redis-backed store.

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
const CODE_LENGTH = 5;
const MAX_MEMBERS_PER_ROOM = 2;

// code -> { code, members: Set<socketId>, hostId, createdAt, playbackState }
const rooms = new Map();

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code)); // collision check — regenerate if taken
  return code;
}

/** Create a new room and register the creating socket as its host. */
function createRoom(hostSocketId) {
  const code = generateCode();
  const room = {
    code,
    members: new Set([hostSocketId]),
    hostId: hostSocketId,
    createdAt: Date.now(),
    // Last known playback state, used to resync a client that reconnects.
    playbackState: {
      type: 'pause',
      currentTime: 0,
      updatedAt: Date.now(),
    },
  };
  rooms.set(code, room);
  return room;
}

/**
 * Add a socket to an existing room.
 * Returns { ok: true, room } or { ok: false, reason }.
 */
function joinRoom(code, socketId) {
  const room = rooms.get(code);

  if (!room) {
    return { ok: false, reason: 'ROOM_NOT_FOUND' };
  }
  if (room.members.has(socketId)) {
    return { ok: true, room }; // already in it (e.g. duplicate join event)
  }
  if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
    return { ok: false, reason: 'ROOM_FULL' };
  }

  room.members.add(socketId);
  return { ok: true, room };
}

function getRoom(code) {
  return rooms.get(code) || null;
}

/** Find the room a given socket currently belongs to, if any. */
function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.members.has(socketId)) return room;
  }
  return null;
}

/** Return the other member's socket id in a 2-person room, if present. */
function getPeerId(room, socketId) {
  for (const memberId of room.members) {
    if (memberId !== socketId) return memberId;
  }
  return null;
}

function updatePlaybackState(room, type, currentTime) {
  room.playbackState = {
    type,
    currentTime,
    updatedAt: Date.now(),
  };
}

/**
 * Remove a socket from whatever room it's in. Deletes the room entirely
 * if it's now empty. Returns the room it was removed from (if any) so
 * the caller can notify remaining members.
 */
function removeSocket(socketId) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;

  room.members.delete(socketId);

  if (room.members.size === 0) {
    rooms.delete(room.code);
  } else if (room.hostId === socketId) {
    // Host left but a peer remains — promote them so the room doesn't
    // become orphaned of authority.
    room.hostId = getPeerId(room, socketId) ?? [...room.members][0];
  }

  return room;
}

module.exports = {
  MAX_MEMBERS_PER_ROOM,
  createRoom,
  joinRoom,
  getRoom,
  findRoomBySocket,
  getPeerId,
  updatePlaybackState,
  removeSocket,
};
