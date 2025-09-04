import type { Request, Response } from "express";
import { StoryService } from "../services/StoryService.js";
import logger from "../../../utils/logger.js";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const storyService = new StoryService();

export class StoryController {
  async generateStory(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { 
        story, 
        style, 
        speakers, 
        voices, 
        tone, 
        duration, 
        imageStyle,
        video = true // Default to true for backward compatibility
      } = req.body;

      // Basic validation
      if (!story || !style || !speakers || !voices || !tone || !duration) {
        res.status(400).json({ 
          error: "Missing required fields: story, style, speakers, voices, tone, duration" 
        });
        return;
      }

      // Only validate imageStyle if video is enabled
      if (video) {
        if (!imageStyle) {
          res.status(400).json({ 
            error: "imageStyle is required when video is enabled" 
          });
          return;
        }

        const validImageStyles = ['realistic', 'comic', 'cartoon', 'drawing', 'watercolor', 'noir', 'sketch'];
        if (!validImageStyles.includes(imageStyle)) {
          res.status(400).json({ 
            error: "Invalid imageStyle. Must be one of: " + validImageStyles.join(', ')
          });
          return;
        }
      }

      const storyId = await storyService.generateStory(userId, {
        story,
        style,
        speakers,
        voices,
        tone,
        duration,
        imageStyle: video ? imageStyle : null,
        video
      });

      res.status(202).json({
        message: "Story created successfully",
        storyId,
        mode: video ? "video" : "audio-only"
      });
    } catch (error) {
      logger.error(`Generate story error: ${error}`);
      res.status(500).json({ error: "Failed to create story" });
    }
  }

  async getVoices(req: Request, res: Response): Promise<void> {
    try {
      const voices = await prisma.voice.findMany({
        orderBy: { name: "asc" },
      });

      res.status(200).json(voices);
    } catch (error) {
      logger.error(`Get voices error: ${error}`);
      res.status(500).json({ error: "Failed to fetch voices" });
    }
  }
}