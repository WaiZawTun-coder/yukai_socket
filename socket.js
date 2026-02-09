import { Server } from "socket.io";
import { verifyJwt } from "./utils/verifyJWT.js";

let io;

/* ============================================================
   In-Memory Stores
============================================================ */

// userId -> Map<socketId, deviceId>
const onlineUsers = new Map();

// userId -> lastSeen timestamp
const lastSeen = new Map();

// userId -> otherUserId (busy tracking)
const activeCalls = new Map();

// userId -> otherUserId (ringing calls)
const pendingCalls = new Map();

/* ============================================================
   Init Socket Server
============================================================ */
const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: ["http://localhost:3000"],
      credentials: true,
    },
    transports: ["websocket"],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  /* ============================================================
     Authentication Middleware
  ============================================================ */
  io.use((socket, next) => {
    try {
      const { token, deviceId, username } = socket.handshake.auth;
      if (!token) return next(new Error("Unauthorized"));

      const decoded = verifyJwt(token);
      if (!decoded) return next(new Error("Unauthorized"));

      if (username && decoded.username !== username) {
        return next(new Error("Identity mismatch"));
      }

      socket.userId = String(decoded.user_id);
      socket.username = decoded.username;
      socket.deviceId = String(deviceId || "unknown");

      next();
    } catch (err) {
      console.error("❌ Socket auth error:", err);
      next(new Error("Unauthorized"));
    }
  });

  /* ============================================================
     Connection
  ============================================================ */
  io.on("connection", (socket) => {
    const userId = String(socket.userId);

    console.log(
      "🟢 Connected:",
      socket.id,
      "User:",
      userId,
      "Device:",
      socket.deviceId
    );

    // Join personal room
    socket.join(userId);

    markUserOnline(userId, socket.id, socket.deviceId);
    io.emit("user-online", { userId });

    /* ============================================================
       Rooms
    ============================================================ */
    socket.on("join-room", (roomId) => {
      if (!roomId) return;
      socket.join(String(roomId));
    });

    socket.on("leave-room", (roomId) => {
      if (!roomId) return;
      socket.leave(String(roomId));
    });

    /* ============================================================
       Messaging
    ============================================================ */
    socket.on("send-message", (message) => {
      if (!message?.chat_id || !message?.cipher_text) return;

      // 1️⃣ Broadcast inside chat room
      socket.to(String(message.chat_id)).emit("receive-message", message);

      // 2️⃣ Deliver to specific devices
      for (const participant of message.participants || []) {
        if (String(participant) === String(message.sender_user_id)) continue;

        const sockets = onlineUsers.get(String(participant));
        if (!sockets) continue;

        for (const [socketId, deviceId] of sockets.entries()) {
          if (String(deviceId) === String(message.recipient_device_id)) {
            io.to(socketId).emit("new-message", message);
          }
        }
      }

      // 3️⃣ ACK sender
      socket.emit("message-sent", {
        status: true,
        temp_id: message.temp_id || null,
      });
    });

    socket.on("update-receipt", ({ message_id, chat_id, status }) => {
      if (!message_id || !chat_id || !status) return;
      socket.to(String(chat_id)).emit("receipt-update", {
        message_id,
        status,
      });
    });

    socket.on("typing", ({ chatId, userId }) => {
      if (!chatId || !userId) return;

      socket.to(String(chatId)).emit("typing", {
        chatId,
        userId,
        typing: true,
      });
    });

    socket.on("stop-typing", ({ chatId, userId }) => {
      if (!chatId || !userId) return;

      socket.to(String(chatId)).emit("typing", {
        chatId,
        userId,
        typing: false,
      });
    });

    /* ============================================================
       Calls + Busy
    ============================================================ */
    const isBusy = (uid) => activeCalls.has(uid) || pendingCalls.has(uid);

    socket.on("call-user", ({ toUsers, callType, caller, roomId }) => {
      const callerId = String(userId);

      if (!Array.isArray(toUsers) || !callType || !caller || !roomId) return;

      // caller still online?
      if (!onlineUsers.has(callerId)) return;

      for (const user of toUsers) {
        const targetUserId = String(user);

        // skip calling yourself
        if (targetUserId === callerId) continue;

        // target online?
        const targetSockets = onlineUsers.get(targetUserId);
        if (!targetSockets || targetSockets.size === 0) {
          socket.emit("user-offline", { toUserId: targetUserId });
          continue;
        }

        // Busy check
        if (isBusy(targetUserId) || isBusy(callerId)) {
          socket.emit("user-busy", { toUserId: targetUserId });
          continue;
        }

        // mark pending
        pendingCalls.set(callerId, targetUserId);
        pendingCalls.set(targetUserId, callerId);

        // ring all target devices
        for (const socketId of targetSockets.keys()) {
          io.to(socketId).emit("incoming-call", {
            callId: roomId,
            fromUserId: callerId,
            callType,
            caller,
            roomId,
          });
        }

        // timeout per target
        setTimeout(() => {
          if (pendingCalls.get(callerId) === targetUserId) {
            pendingCalls.delete(callerId);
            pendingCalls.delete(targetUserId);

            io.to(callerId).emit("call-timeout");
            io.to(targetUserId).emit("call-timeout");
            io.to(targetUserId).emit("stop-ringing");
          }
        }, 30000);
      }
    });

    socket.on("answer-call", ({ callId, toUserId }) => {
      const callerId = String(toUserId);
      const calleeId = String(userId);

      // move pending → active
      if (pendingCalls.get(callerId) === calleeId) {
        pendingCalls.delete(callerId);
        pendingCalls.delete(calleeId);

        activeCalls.set(callerId, calleeId);
        activeCalls.set(calleeId, callerId);

        io.to(callerId).emit("call-answered", {
          fromUserId: calleeId,
          callId,
        });

        io.to(calleeId).emit("stop-ringing");
      }
    });

    socket.on("reject-call", ({ callId, toUserId }) => {
      const callerId = String(toUserId);
      const calleeId = String(userId);

      pendingCalls.delete(callerId);
      pendingCalls.delete(calleeId);

      activeCalls.delete(callerId);
      activeCalls.delete(calleeId);

      io.to(callerId).emit("call-rejected", {
        fromUserId: calleeId,
        callId,
      });

      io.to(calleeId).emit("stop-ringing");
    });

    socket.on("end-call", ({ toUserId, roomId }) => {
      const peerId = String(toUserId);
      const callerId = String(userId);

      pendingCalls.delete(callerId);
      pendingCalls.delete(peerId);

      activeCalls.delete(callerId);
      activeCalls.delete(peerId);

      const payload = {
        fromUserId: callerId,
        roomId: roomId || null,
      };

      io.to(peerId).emit("call-ended", payload);
      io.to(callerId).emit("call-ended", payload);
    });

    socket.on("check-user-busy", (targetUserId) => {
      const uid = String(targetUserId);

      socket.emit("busy-status", {
        userId: uid,
        busy: isBusy(uid),
        peerId: activeCalls.get(uid) || pendingCalls.get(uid) || null,
      });
    });
    /* ============================================================
       Online Status
    ============================================================ */

    socket.on("check-user-online", (targetUserId) => {
      const uid = String(targetUserId);

      socket.emit("user-status", {
        userId: uid,
        online: onlineUsers.has(uid),
        lastSeen: lastSeen.get(uid) || null,
      });
    });

    socket.on("request-online-users", () => {
      const users = Array.from(onlineUsers.keys());

      socket.emit("online-users", {
        users,
      });
    });

    /* ============================================================
       Notify user actions (react, comment, friend requests <sent request, accept request, follow>)
    ============================================================ */

    const emitNotification = (type, payload) => {
      const { referenceId, message, target_user_id, sender_id } = payload;

      if (!referenceId || !message || !target_user_id || !sender_id) {
        console.warn("Invalid notification payload", payload);
        return;
      }

      // Always normalize to array
      const targetIds = Array.isArray(target_user_id)
        ? target_user_id
        : [target_user_id];

      for (const target of targetIds) {
        // Don't notify yourself
        if (Number(target) === Number(sender_id)) continue;

        const targetSockets = onlineUsers.get(String(target));
        if (!targetSockets || targetSockets.size === 0) continue;

        for (const socketId of targetSockets.keys()) {
          io.to(socketId).emit("notification", {
            ...payload,
            type,
            created_at: Date.now(),
          });
        }
      }
    };

    // --------------------
    // Event listeners
    // --------------------
    socket.on("post-react", (payload) => emitNotification("react", payload));
    socket.on("post-comment", (payload) =>
      emitNotification("comment", payload)
    );
    socket.on("account-request", (payload) =>
      emitNotification("request", payload)
    );

    /* ============================================================
       Disconnect
    ============================================================ */

    socket.on("disconnect", () => {
      console.log("🔴 Disconnected:", socket.id);

      markUserOffline(userId, socket.id);

      // clear calls
      const peer = activeCalls.get(userId) || pendingCalls.get(userId);

      if (peer) {
        activeCalls.delete(userId);
        activeCalls.delete(peer);
        pendingCalls.delete(userId);
        pendingCalls.delete(peer);

        io.to(peer).emit("call-ended", {
          fromUserId: userId,
        });
      }

      if (!onlineUsers.has(userId)) {
        io.emit("user-offline", {
          userId,
          lastSeen: lastSeen.get(userId),
        });
      }
    });
  });
};

/* ============================================================
   Helpers
============================================================ */

function setUserBusy(userId, peerId) {
  const uid = String(userId);
  const pid = String(peerId);

  activeCalls.set(uid, pid);

  io.to(uid).emit("busy-status", {
    userId: uid,
    busy: true,
    peerId: pid,
  });
}

function clearUserBusy(userId) {
  const uid = String(userId);
  const peer = activeCalls.get(uid);

  activeCalls.delete(uid);

  io.to(uid).emit("busy-status", {
    userId: uid,
    busy: false,
    peerId: null,
  });

  return peer;
}

function markUserOnline(userId, socketId, deviceId) {
  const uid = String(userId);

  if (!onlineUsers.has(uid)) {
    onlineUsers.set(uid, new Map());
  }

  onlineUsers.get(uid).set(socketId, deviceId);
}

function markUserOffline(userId, socketId) {
  const uid = String(userId);
  const sockets = onlineUsers.get(uid);
  if (!sockets) return;

  sockets.delete(socketId);

  if (sockets.size === 0) {
    onlineUsers.delete(uid);
    lastSeen.set(uid, Date.now());
  }
}

export { initSocket };
