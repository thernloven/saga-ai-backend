// SubtitleController.ts
import type { Request, Response } from "express";
import prisma from "../../../lib/prisma.js";
import axios from "axios";
import logger from "../../../utils/logger.js";

const SUPPORTED_LANGUAGES = ['cs', 'nl', 'en', 'fr', 'de', 'it', 'ja', 'ko', 'pl', 'pt', 'ru', 'es'];
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLL_ATTEMPTS = 60; // Max 5 minutes of polling

export class SubtitleController {
  async generateCaptions(req: Request, res: Response): Promise<void> {
    try {
      const storyId = req.params.storyId;
      const { language = 'en' } = req.body;
      const userId = req.user?.id; // Assuming auth middleware adds user to req

      // Check authentication first
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      // Check if storyId is provided
      if (!storyId) {
        res.status(400).json({ error: "Story ID is required" });
        return;
      }

      // Validate language
      if (!SUPPORTED_LANGUAGES.includes(language)) {
        res.status(400).json({ 
          error: `Invalid language. Supported: ${SUPPORTED_LANGUAGES.join(', ')}` 
        });
        return;
      }

      // Check if user owns this story and get cloudflare_id
      const story = await prisma.story.findFirst({
        where: {
          id: storyId,
          user_id: userId
        },
        select: {
          cloudflare_id: true,
          title: true
        }
      });

      if (!story) {
        res.status(404).json({ error: "Story not found or access denied" });
        return;
      }

      if (!story.cloudflare_id) {
        res.status(400).json({ error: "Video not yet uploaded to Cloudflare Stream" });
        return;
      }

      // Initiate caption generation
      const generateResult = await this.initiateCaption(story.cloudflare_id, language);
      
      // Check if caption already exists
      if (!generateResult.success && generateResult.errors?.[0]?.code === 10005) {
        const message = generateResult.messages?.[0]?.message;
        if (message && message.includes("existing caption")) {
          res.status(409).json({ 
            error: "Caption already exists",
            message: `Caption for language '${language}' already exists. Please delete existing caption first.`,
            language: language
          });
          return;
        }
      }
      
      if (!generateResult.success) {
        res.status(500).json({ 
          error: "Failed to initiate caption generation",
          details: generateResult.errors 
        });
        return;
      }

      // Start polling for completion
      const pollResult = await this.pollForCaption(story.cloudflare_id, language);
      
      if (pollResult.ready) {
        res.status(200).json({ 
          success: true,
          message: "Captions generated successfully",
          language: language,
          storyId: storyId
        });
      } else {
        res.status(500).json({ 
          error: "Caption generation timed out or failed",
          message: "Please try again later" 
        });
      }

    } catch (error) {
      logger.error(`Caption generation error: ${error}`);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  private async initiateCaption(cloudflareId: string, language: string): Promise<any> {
    try {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const token = process.env.CLOUDFLARE_TOKEN;

      if (!accountId || !token) {
        throw new Error('Cloudflare credentials not configured');
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${cloudflareId}/captions/${language}/generate`;

      const response = await axios.post(
        url,
        {},
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          validateStatus: () => true // Accept any status code to handle errors
        }
      );

      logger.info(`Caption generation response status: ${response.status}`);
      
      // Return the data regardless of success/failure for handling in main function
      return response.data;

    } catch (error) {
      logger.error(`Failed to initiate caption generation: ${error}`);
      throw error;
    }
  }

  private async pollForCaption(
    cloudflareId: string, 
    language: string
  ): Promise<{ ready: boolean }> {
    try {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const token = process.env.CLOUDFLARE_TOKEN;

      if (!accountId || !token) {
        throw new Error('Cloudflare credentials not configured');
      }

      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${cloudflareId}/captions`;

      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        const response = await axios.get(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        if (response.data.success) {
          const caption = response.data.result.find(
            (cap: any) => cap.language === language
          );

          if (caption?.status === 'ready') {
            logger.info(`Captions ready for ${cloudflareId} in ${language}`);
            return { ready: true };
          } else if (caption?.status === 'error') {
            logger.error(`Caption generation failed for ${cloudflareId}`);
            return { ready: false };
          }
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        logger.info(`Polling caption status: attempt ${attempt + 1}/${MAX_POLL_ATTEMPTS}`);
      }

      logger.warn(`Caption generation timed out after ${MAX_POLL_ATTEMPTS} attempts`);
      return { ready: false };

    } catch (error) {
      logger.error(`Error polling for caption status: ${error}`);
      return { ready: false };
    }
  }
}