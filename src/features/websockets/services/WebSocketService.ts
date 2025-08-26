// src/features/websockets/services/WebSocketService.ts
import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import prisma from '../../../lib/prisma.js';
import logger from '../../../utils/logger.js';
import url from 'url';
import type { JwtPayload } from '../../../middleware/auth.js';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  storyId?: string;
}

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Map<string, Set<AuthenticatedWebSocket>> = new Map(); // storyId -> Set of WebSocket clients
  private intervals: Map<string, NodeJS.Timeout> = new Map(); // storyId -> polling interval

  constructor(server: HTTPServer) {
    logger.info('Initializing WebSocket Service...');
    
    this.wss = new WebSocketServer({ 
      server,
      verifyClient: (info, callback) => {
        logger.info(`WebSocket connection attempt from ${info.req.socket.remoteAddress}`);
        logger.info(`Request URL: ${info.req.url}`);
        
        // Parse URL to get query params
        const parsedUrl = url.parse(info.req.url || '', true);
        const query = parsedUrl.query;
        
        logger.info(`Query params: ${JSON.stringify(query)}`);
        
        const token = query.token as string;
        const storyId = query.storyId as string;
        
        if (!token) {
          logger.error('No token provided in query parameters');
          callback(false, 401, 'Unauthorized - No token');
          return;
        }
        
        if (!storyId) {
          logger.error('No storyId provided in query parameters');
          callback(false, 400, 'Bad Request - No storyId');
          return;
        }

        logger.info(`Token received: ${token.substring(0, 20)}...`);
        logger.info(`StoryId received: ${storyId}`);

        try {
          // Verify JWT token
          logger.info('Verifying JWT token...');
          const decoded = jwt.verify(token, process.env.JWT_SECRET!);
          
          logger.info(`Token decoded: ${JSON.stringify(decoded)}`);
          
          if (typeof decoded === 'object' && decoded !== null && 'id' in decoded) {
            const userId = (decoded as JwtPayload).id;
            logger.info(`User authenticated: ${userId}`);
            
            // Store userId and storyId on request for connection handler
            (info.req as any).userId = userId;
            (info.req as any).storyId = storyId;
            callback(true);
          } else {
            logger.error('Token decoded but missing id field');
            callback(false, 401, 'Invalid token - Missing user id');
          }
        } catch (error) {
          logger.error(`JWT verification failed: ${error}`);
          callback(false, 401, 'Invalid token');
        }
      }
    });

    this.setupEventHandlers();
    logger.info('WebSocket Service initialized');
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    this.wss.on('connection', (ws: AuthenticatedWebSocket, request) => {
      // Get userId and storyId from request (set during verification)
      const userId = (request as any).userId;
      const storyId = (request as any).storyId;
      
      logger.info(`WebSocket connection established - User: ${userId}, Story: ${storyId}`);

      if (!storyId || !userId) {
        logger.error(`Missing parameters - userId: ${userId}, storyId: ${storyId}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid connection parameters' }));
        ws.close();
        return;
      }

      ws.userId = userId;
      ws.storyId = storyId;

      // Add client to the story group
      if (!this.clients.has(storyId)) {
        this.clients.set(storyId, new Set());
        logger.info(`Created new client group for story: ${storyId}`);
        // Start polling for this story
        this.startPolling(storyId, userId);
      }
      
      this.clients.get(storyId)!.add(ws);
      logger.info(`Client added. Total clients for ${storyId}: ${this.clients.get(storyId)!.size}`);

      // Handle client disconnect
      ws.on('close', () => {
        logger.info(`Client disconnecting for story: ${storyId}`);
        const clientSet = this.clients.get(storyId);
        if (clientSet) {
          clientSet.delete(ws);
          logger.info(`Remaining clients for ${storyId}: ${clientSet.size}`);
          
          if (clientSet.size === 0) {
            logger.info(`No clients left for ${storyId}, stopping polling`);
            this.stopPolling(storyId);
            this.clients.delete(storyId);
          }
        }
      });

      // Handle errors
      ws.on('error', (error) => {
        logger.error(`WebSocket error for story ${storyId}: ${error}`);
      });

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        storyId: storyId
      }));

      // Immediately check status
      this.checkStoryStatus(storyId, userId);
    });
  }

  /**
   * Start polling for story status
   */
  private startPolling(storyId: string, userId: string): void {
    logger.info(`Starting polling for story: ${storyId}`);
    
    const interval = setInterval(() => {
      this.checkStoryStatus(storyId, userId);
    }, 3000);

    this.intervals.set(storyId, interval);
  }

  /**
   * Stop polling for story status
   */
  private stopPolling(storyId: string): void {
    const interval = this.intervals.get(storyId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(storyId);
      logger.info(`Polling stopped for story: ${storyId}`);
    }
  }

  /**
   * Check story status and notify clients
   */
  private async checkStoryStatus(storyId: string, userId: string): Promise<void> {
    try {
      // Check if story exists and belongs to user
      const story = await prisma.story.findFirst({
        where: {
          id: storyId,
          user_id: userId
        }
      });

      if (!story) {
        logger.error(`Story not found: ${storyId} for user: ${userId}`);
        this.notifyClients(storyId, {
          type: 'error',
          message: 'Story not found or access denied'
        });
        this.stopPolling(storyId);
        return;
      }

      logger.info(`Story ${storyId} status: ${story.status}`);

      // Check if completed
      if (story.status === 'completed') {
        logger.info(`Story ${storyId} completed, sending data`);
        
        // Get image URL
        let imageUrl = story.image_url;
        
        if (!imageUrl) {
          logger.info(`No image in stories table, checking images table`);
          const firstImage = await prisma.image.findFirst({
            where: {
              story_id: storyId,
              scene_id: 'scene_1',
              shot_number: 1
            },
            select: { image_url: true }
          });

          imageUrl = firstImage?.image_url || null;
          logger.info(`Image from images table: ${imageUrl}`);
        }

        // Send completed data
        this.notifyClients(storyId, {
          type: 'completed',
          data: {
            title: story.title || 'Untitled Story',
            video_url: story.video_url,
            image_url: imageUrl,
            created_at: story.created_at,
            duration: story.duration || '0'
          }
        });

        // Stop polling
        this.stopPolling(storyId);
      } else {
        // Still processing
        this.notifyClients(storyId, {
          type: 'status',
          status: story.status,
          message: `Story is ${story.status}`
        });
      }
    } catch (error) {
      logger.error(`Error checking story: ${error}`);
      this.notifyClients(storyId, {
        type: 'error',
        message: 'Failed to check story status'
      });
    }
  }

  /**
   * Send message to all clients watching a story
   */
  private notifyClients(storyId: string, message: any): void {
    const clients = this.clients.get(storyId);
    
    if (clients && clients.size > 0) {
      const messageStr = JSON.stringify(message);
      
      clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
        }
      });
    }
  }

  /**
   * Get connected clients count
   */
  public getConnectedClientsCount(): number {
    let total = 0;
    this.clients.forEach(clientSet => {
      total += clientSet.size;
    });
    return total;
  }

  /**
   * Get active stories being monitored
   */
  public getActiveStories(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Cleanup
   */
  public cleanup(): void {
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals.clear();
    this.wss.close();
    logger.info('WebSocket server closed');
  }
}