// src/features/websockets/services/WebSocketService.ts
import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import prisma from '../../../lib/prisma.js';
import logger from '../../../utils/logger.js';
import url from 'url';
import { Client as PgClient } from 'pg';
import type { Notification } from 'pg';
import type { JwtPayload } from '../../../middleware/auth.js';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  storyId?: string;
}

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Map<string, Set<AuthenticatedWebSocket>> = new Map(); // storyId -> Set of WebSocket clients
  private pgClient!: PgClient;

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
    this.setupPgListener();
    logger.info('WebSocket Service initialized');
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    this.wss.on('connection', (ws: AuthenticatedWebSocket, request) => {
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

      if (!this.clients.has(storyId)) {
        this.clients.set(storyId, new Set());
        logger.info(`Created new client group for story: ${storyId}`);
      }
      
      this.clients.get(storyId)!.add(ws);
      logger.info(`Client added. Total clients for ${storyId}: ${this.clients.get(storyId)!.size}`);

      // Handle disconnect
      ws.on('close', () => {
        logger.info(`Client disconnecting for story: ${storyId}`);
        const clientSet = this.clients.get(storyId);
        if (clientSet) {
          clientSet.delete(ws);
          logger.info(`Remaining clients for ${storyId}: ${clientSet.size}`);
          if (clientSet.size === 0) {
            this.clients.delete(storyId);
          }
        }
      });

      ws.on('error', (error) => {
        logger.error(`WebSocket error for story ${storyId}: ${error}`);
      });

      ws.send(JSON.stringify({ type: 'connected', storyId }));
    });
  }

  /**
   * Setup Postgres LISTEN/NOTIFY
   */
  private setupPgListener(): void {
    this.pgClient = new PgClient({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    this.pgClient.connect();
    this.pgClient.query('LISTEN completed');

    this.pgClient.on('notification', async (msg: Notification) => {
      if (msg.channel === 'completed') {
        const storyId = msg.payload!;
        logger.info(`Received NOTIFY 'completed' for story ${storyId}`);

        try {
          const story = await prisma.story.findUnique({ where: { id: storyId } });
          if (story && story.status === 'completed') {
            this.notifyClients(storyId, {
              type: 'completed',
              data: {
                title: story.title || 'Untitled Story',
                video_url: story.video_url,
                image_url: story.image_url,
                created_at: story.created_at,
                duration: story.duration || '0'
              }
            });
          }
        } catch (error) {
          logger.error(`Error handling completed notification: ${error}`);
        }
      }
    });
  }

  /**
   * Send message to all clients watching a story
   */
  private notifyClients(storyId: string, message: any): void {
    const clients = this.clients.get(storyId);
    if (clients && clients.size > 0) {
      const msg = JSON.stringify(message);
      clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      });
    }
  }

  public getConnectedClientsCount(): number {
    let total = 0;
    this.clients.forEach(set => { total += set.size; });
    return total;
  }

  public getActiveStories(): string[] {
    return Array.from(this.clients.keys());
  }

  public cleanup(): void {
    this.pgClient?.end();
    this.wss.close();
    logger.info('WebSocket server closed');
  }
}