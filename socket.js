import { Server } from "socket.io";

let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*", // Replace with your frontend URL in production
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("🟢 Client connected:", socket.id);

    // Join Room
    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      console.log(`📥 Socket ${socket.id} joined room ${roomId}`);
    });

    // Leave Room
    socket.on("leave-room", (roomId) => {
      socket.leave(roomId);
      console.log(`📤 Socket ${socket.id} left room ${roomId}`);
    });

    // Receive Message From Client
    socket.on("send-message", async (message) => {
      console.log("📩 Message received:", message);

      // TODO: Save message to DB here if needed
      // await saveMessage(message);

      // Broadcast to other participants in the room
      socket.to(message.chat_id).emit("receive-message", message);

      // Optional: Ack to sender
      socket.emit("message-sent", {
        status: true,
        temp_id: message.temp_id || null,
      });
    });

    // Handle delivery or seen receipt updates
    socket.on("update-receipt", ({ message_id, chat_id, status }) => {
      console.log(`📦 Receipt update: message ${message_id}, status ${status}`);

      // Broadcast to other participants in the chat
      socket.to(chat_id).emit("receipt-update", { message_id, status });
    });

    socket.on("disconnect", () => {
      console.log("🔴 Client disconnected:", socket.id);
    });
  });
};

export { initSocket };
