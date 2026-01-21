import express, { json } from "express";
import { createServer } from "http";
import cors from "cors";
import { initSocket } from "./socket.js";

const app = express();

app.use(
  cors({
    origin: process.env.url || "*",
    credentials: true,
  })
);
app.use(json());

app.get("/", (req, res) => {
  res.status(200).send("Socket server is running");
});

const server = createServer(app);

initSocket(server);

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
