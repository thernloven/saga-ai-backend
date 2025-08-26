// src/features/websockets/controllers/WebSocketController.ts
import type { Request, Response } from 'express';
import { WebSocketService } from '../services/WebSocketService.js';
import logger from '../../../utils/logger.js';

export class WebSocketController {
  private webSocketService: WebSocketService;

  constructor(webSocketService: WebSocketService) {
    this.webSocketService = webSocketService;
  }

  /**
   * Get WebSocket info
   * GET /api/websocket/info
   */
  getInfo = async (req: Request, res: Response): Promise<void> => {
    try {
      const connectedClients = this.webSocketService.getConnectedClientsCount();
      const activeStories = this.webSocketService.getActiveStories();
      
      res.status(200).json({
        success: true,
        data: {
          status: 'active',
          endpoint: 'ws://localhost:3001/ws/?token={jwt_token}&storyId={storyId}',
          connected_clients: connectedClients,
          active_stories: activeStories.length,
          stories: activeStories
        },
      });
    } catch (error) {
      logger.error(`Error in WebSocket info controller: ${error}`);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  };
}