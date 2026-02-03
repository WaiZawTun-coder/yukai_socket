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

      console.log("📩 Message:", message.message_id);

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

    /* ============================================================
       Calls + Busy
    ============================================================ */

    socket.on("call-user", ({ toUserId, callType, caller, roomId }) => {
      const targetUserId = String(toUserId);

      console.log("📞 Call request:", {
        from: userId,
        to: targetUserId,
        callType,
        roomId,
      });

      if (!targetUserId || !callType || !caller || !roomId) return;

      if (targetUserId === userId) return;

      const targetSockets = onlineUsers.get(targetUserId);

      if (!targetSockets || targetSockets.size === 0) {
        socket.emit("user-offline", { toUserId: targetUserId });
        return;
      }

      if (activeCalls.has(targetUserId)) {
        socket.emit("user-busy", { toUserId: targetUserId });
        return;
      }

      // ✅ Mark both users busy
      setUserBusy(userId, targetUserId);
      setUserBusy(targetUserId, userId);

      // 🔔 Ring all target devices
      for (const socketId of targetSockets.keys()) {
        io.to(socketId).emit("incoming-call", {
          callId: roomId,
          fromUserId: userId,
          callType,
          caller,
          roomId,
        });
      }

      // ⏱ Auto timeout
      setTimeout(() => {
        if (activeCalls.get(userId) === targetUserId) {
          console.log("⏱ Call timeout");

          clearUserBusy(userId);
          clearUserBusy(targetUserId);

          io.to(userId).emit("call-timeout");
          io.to(targetUserId).emit("call-timeout");
        }
      }, 30000);
    });

    socket.on("answer-call", ({ callId, toUserId }) => {
      const targetUserId = String(toUserId);
      if (!targetUserId) return;

      io.to(targetUserId).emit("call-answered", {
        fromUserId: userId,
      });
    });

    socket.on("reject-call", ({ callId, toUserId }) => {
      const targetUserId = String(toUserId);
      if (!targetUserId) return;

      clearUserBusy(userId);
      clearUserBusy(targetUserId);

      io.to(targetUserId).emit("call-rejected", {
        fromUserId: userId,
      });
    });

    socket.on("end-call", ({ toUserId }) => {
      const targetUserId = String(toUserId);
      if (!targetUserId) return;

      clearUserBusy(userId);
      clearUserBusy(targetUserId);

      io.to(targetUserId).emit("call-ended", {
        fromUserId: userId,
      });
    });

    socket.on("check-user-busy", (targetUserId) => {
      const uid = String(targetUserId);

      socket.emit("busy-status", {
        userId: uid,
        busy: activeCalls.has(uid),
        peerId: activeCalls.get(uid) || null,
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

    /* ============================================================
       Notify user actions (react, comment, friend requests <sent request, accept request, follow>)
    ============================================================ */

    const emitNotification = (type, payload) => {
      console.log({ payload });
      const { referenceId, message, target_user_id, sender_id } = payload;

      if (!referenceId || !message || !target_user_id || !sender_id) return;

      // Don't notify yourself
      if (target_user_id === sender_id) return;

      const targetSockets = onlineUsers.get(String(target_user_id));
      if (!targetSockets || targetSockets.size === 0) return;

      for (const socketId of targetSockets.keys()) {
        io.to(socketId).emit("notification", {
          ...payload,
          type, // "react", "comment", "request"
          created_at: Date.now(),
        });
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

      if (!onlineUsers.has(userId)) {
        io.emit("user-offline", {
          userId,
          lastSeen: lastSeen.get(userId),
        });

        const peer = clearUserBusy(userId);
        if (peer) {
          clearUserBusy(peer);
          io.to(peer).emit("call-ended", {
            fromUserId: userId,
          });
        }
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
