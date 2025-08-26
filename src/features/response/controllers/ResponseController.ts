import type { Request, Response } from "express";
import { ResponseService } from "../services/ResponseService.js";
import logger from "../../../utils/logger.js";
import type { WebhookEvent } from "../types/index.js";

const responseService = new ResponseService();

export class ResponseController {
  async handleWebhook(req: Request, res: Response): Promise<void> {
    try {
      const webhookData: WebhookEvent = req.body;

      logger.info(`Received webhook: ${webhookData.type} for ${webhookData.data.id}`);

      // Process the webhook
      await responseService.handleWebhook(webhookData);

      res.status(200).json({ received: true });
    } catch (error) {
      logger.error(`Webhook error: ${error}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  // In ResponseController class
async handleCloudflareWebhook(req: Request, res: Response): Promise<void> {
  try {
    const webhookData = req.body;
    
    logger.info(`Received Cloudflare webhook for video: ${webhookData.meta?.name || 'unknown'}`);
    
    // Only process if the video is ready
    if (webhookData.status?.state !== 'ready' || !webhookData.readyToStream) {
      logger.info(`Video not ready yet: ${webhookData.status?.state}`);
      res.status(200).json({ received: true });
      return;
    }
    
    await responseService.handleCloudflareVideoReady(webhookData);
    
    res.status(200).json({ received: true });
  } catch (error) {
    logger.error(`Cloudflare webhook error: ${error}`);
    res.status(500).json({ error: "Internal server error" });
  }
}
}