import type { Request, Response } from "express";
import { StoryService } from "../services/StoryService.js";
import logger from "../../../utils/logger.js";

const storyService = new StoryService();

export class StoryController {
  async generateStory(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const { story, style, speakers, voices, tone, duration, imageStyle } = req.body;

      // Basic validation
      if (!story || !style || !speakers || !voices || !tone || !duration || !imageStyle) {
        res.status(400).json({ 
          error: "Missing required fields: story, style, speakers, voices, tone, duration, imageStyle" 
        });
        return;
      }

      // Validate imageStyle
      const validImageStyles = ['realistic', 'comic', 'cartoon', 'drawing', 'watercolor', 'noir', 'sketch'];
      if (!validImageStyles.includes(imageStyle)) {
        res.status(400).json({ 
          error: "Invalid imageStyle. Must be one of: " + validImageStyles.join(', ')
        });
        return;
      }

      const storyId = await storyService.generateStory(userId, {
        story,
        style,
        speakers,
        voices,
        tone,
        duration,
        imageStyle
      });

      res.status(202).json({
        message: "Story created successfully",
        storyId
      });
    } catch (error) {
      logger.error(`Generate story error: ${error}`);
      res.status(500).json({ error: "Failed to create story" });
    }
  }
}