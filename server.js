import express, { json } from "express";
import { createServer } from "http";
import cors from "cors";

import { initSocket } from "./socket.js";

const app = express();
app.use(cors());
app.use(json());

const server = createServer(app);

// Initialize socket
initSocket(server);

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
