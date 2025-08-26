// src/app.ts
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { createServer } from 'http';
import router from "./routes/index.js";
import { WebSocketService } from './features/websockets/services/WebSocketService.js';
import { WebSocketController } from './features/websockets/controllers/WebSocketController.js';
import logger from './utils/logger.js';

const app = express();
const httpServer = createServer(app);

// Initialize WebSocket Service
const webSocketService = new WebSocketService(httpServer);
const webSocketController = new WebSocketController(webSocketService);

// Middleware
app.use(express.json());

// API routes
app.use("/api", router);

// WebSocket info endpoint
app.get('/api/websocket/info', webSocketController.getInfo);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date(),
    websocket: {
      clients: webSocketService.getConnectedClientsCount(),
      stories: webSocketService.getActiveStories().length
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/{storyId}?token={token}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  webSocketService.cleanup();
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});