// rooms.js
//
// In-memory room state. No database — rooms live only as long as the
// server process does, which is fine for a lightweight sync-watch app.
// If you need rooms to survive a server restart later, this is the file
// to swap out for a Redis-backed store.
//
// members is a Map<socketId, nickname> rather than a plain Set, so the
// server can tell everyone in the room who everyone else actually is
// (used for chat attribution and the room member list).

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
const CODE_LENGTH = 5;
const MAX_MEMBERS_PER_ROOM = 10;
const MAX_NICKNAME_LENGTH = 24;
const MAX_VOICE_MEMBERS = 4; // free-tier mesh WebRTC — see socketHandlers.js for why

// code -> { code, members: Map<socketId, nickname>, hostId, createdAt, playbackState }
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

function sanitizeNickname(raw) {
  const trimmed = (raw || '').toString().trim().slice(0, MAX_NICKNAME_LENGTH);
  return trimmed || 'Guest';
}

/** Create a new room and register the creating socket as its host. */
function createRoom(hostSocketId, nickname) {
  const code = generateCode();
  const room = {
    code,
    members: new Map([[hostSocketId, sanitizeNickname(nickname)]]),
    hostId: hostSocketId,
    createdAt: Date.now(),
    playbackState: {
      type: 'pause',
      currentTime: 0,
      updatedAt: Date.now(),
    },
    voiceMembers: new Set(), // capped at MAX_VOICE_MEMBERS — see below
  };
  rooms.set(code, room);
  return room;
}

/**
 * Add a socket to an existing room.
 * Returns { ok: true, room } or { ok: false, reason }.
 */
function joinRoom(code, socketId, nickname) {
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

  room.members.set(socketId, sanitizeNickname(nickname));
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

/** [{ socketId, nickname }] for everyone currently in the room. */
function getRoster(room) {
  return [...room.members.entries()].map(([socketId, nickname]) => ({ socketId, nickname }));
}

function getNickname(room, socketId) {
  return room.members.get(socketId) || 'Guest';
}

function updatePlaybackState(room, type, currentTime) {
  room.playbackState = {
    type,
    currentTime,
    updatedAt: Date.now(),
  };
}

/**
 * Heartbeat updates only refresh the known currentTime — they don't
 * represent a play/pause state change, just "here's roughly where I am
 * right now." Keeping this separate from updatePlaybackState() means a
 * heartbeat can never accidentally overwrite the room's play/pause type.
 */
function updatePlaybackTime(room, currentTime) {
  room.playbackState.currentTime = currentTime;
  room.playbackState.updatedAt = Date.now();
}

/**
 * Add a socket to the room's voice call, up to MAX_VOICE_MEMBERS.
 * Returns true if they got a seat, false if voice is full (they should
 * use the buzzer instead — see socketHandlers.js).
 */
function addVoiceMember(room, socketId) {
  if (room.voiceMembers.has(socketId)) return true;
  if (room.voiceMembers.size >= MAX_VOICE_MEMBERS) return false;
  room.voiceMembers.add(socketId);
  return true;
}

function removeVoiceMember(room, socketId) {
  room.voiceMembers.delete(socketId);
}

/** [{ socketId, nickname }] for everyone currently in the voice call. */
function getVoiceRoster(room) {
  return [...room.voiceMembers].map((socketId) => ({
    socketId,
    nickname: getNickname(room, socketId),
  }));
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
  room.voiceMembers.delete(socketId);

  if (room.members.size === 0) {
    rooms.delete(room.code);
  } else if (room.hostId === socketId) {
    // Host left but people remain — promote the next member so the
    // room doesn't become orphaned of authority.
    room.hostId = [...room.members.keys()][0];
  }

  return room;
}

module.exports = {
  MAX_MEMBERS_PER_ROOM,
  MAX_VOICE_MEMBERS,
  createRoom,
  joinRoom,
  getRoom,
  findRoomBySocket,
  getRoster,
  getNickname,
  updatePlaybackState,
  updatePlaybackTime,
  addVoiceMember,
  removeVoiceMember,
  getVoiceRoster,
  removeSocket,
};
