import prisma from "../../../lib/prisma.js";
import axios from "axios";
import logger from "../../../utils/logger.js";
import type { WebhookEvent, OpenAIResponseData } from "../../story/types/index.js";
import { ImageService } from "../../story/services/ImageService.js";
import { SpeechService } from "../../story/services/SpeechService.js";
import { MusicService } from "../../story/services/MusicService.js";
import { StoryCompletionService } from "../../events/StoryCompletionService.js";

const imageService = new ImageService();
const speechService = new SpeechService();
const musicService = new MusicService();
const storyCompletionService = new StoryCompletionService();

export class ResponseService {
  private buildMusicPrompt(style: string, tone: string): string {
    const basePrompt = `${tone} ${style} background instrumental for podcast`;
    
    // Add specific descriptors based on style and tone
    const styleDescriptors = {
      documentary: "cinematic, atmospheric",
      interview: "subtle, professional", 
      narrative: "storytelling, engaging",
      educational: "calm, focused"
    };

    const toneDescriptors = {
      mysterious: "ambient, suspenseful, dark undertones",
      informative: "clean, unobtrusive, professional",
      dramatic: "intense, building tension",
      conversational: "warm, friendly, light"
    };

    const styleDesc = styleDescriptors[style as keyof typeof styleDescriptors] || "ambient";
    const toneDesc = toneDescriptors[tone as keyof typeof toneDescriptors] || "neutral";

    return `${basePrompt}, ${styleDesc}, ${toneDesc}`;
  }

  async handleWebhook(webhookData: WebhookEvent): Promise<void> {
    try {
      if (webhookData.type !== 'response.completed') {
        logger.info(`Ignoring webhook type: ${webhookData.type}`);
        return;
      }

      const responseId = webhookData.data.id;
      logger.info(`Processing completed response: ${responseId}`);

      // 1. Check if this response exists in our database
      const response = await prisma.response.findUnique({
        where: { response_id: responseId }
      });

      if (!response) {
        logger.warn(`Response not found in database: ${responseId}`);
        return;
      }

      // 2. Get the full response data from OpenAI
      const responseData = await this.getOpenAIResponse(responseId);

      // 3. Handle based on response type
      if (response.type === 'script') {
        await this.handleScriptCompletion(responseId, responseData);
      } else if (response.type === 'image') {
        await this.handleImageCompletion(responseId, responseData);
      } else if (response.type === 'anchor') {
        await this.handleAnchorCompletion(responseId, responseData);
      }

    } catch (error) {
      logger.error(`Error handling webhook: ${error}`);
      throw error;
    }
  }

  private async getOpenAIResponse(responseId: string): Promise<OpenAIResponseData> {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured');
      }

      const response = await axios.get(
        `https://api.openai.com/v1/responses/${responseId}`,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data;
    } catch (error) {
      logger.error(`Failed to get OpenAI response: ${error}`);
      throw error;
    }
  }

private async handleScriptCompletion(responseId: string, responseData: OpenAIResponseData): Promise<void> {
  try {
    // Find the story with this response_id
    const story = await prisma.story.findUnique({
      where: { response_id: responseId }
    });

    if (!story) {
      logger.warn(`Story not found for response: ${responseId}`);
      return;
    }

    // Extract the script from the response
    const messageOutput = responseData.output?.find(output => output.type === 'message');
    if (!messageOutput?.content) {
      throw new Error('No message content found in response');
    }

    const textContent = messageOutput.content.find(content => content.type === 'output_text');
    if (!textContent?.text) {
      throw new Error('No text content found in response');
    }

    const scriptData = JSON.parse(textContent.text);

    // Update the story with script data
    await prisma.story.update({
      where: { id: story.id },
      data: {
        title: scriptData.title,
        transcript: JSON.stringify(scriptData),
        status: 'script_completed'
      }
    });

    logger.info(`Story script completed: ${story.id}`);

    // Store all anchors in database
    await this.storeAnchors(story.id, scriptData);

    // Fire off anchor image generation for entities appearing 2+ times
    imageService
      .generateAnchorImages(story.id, scriptData.metadata.imageStyle)
      .catch((err) => logger.error(`Anchor image generation failed for story ${story.id}: ${err}`));

    // Fire-and-forget: kick off music generation
    const duration = typeof story.duration === 'string' ? parseInt(story.duration, 10) : story.duration;
    const musicPrompt = this.buildMusicPrompt(story.style, story.tone);
    musicService
      .generateMusic(story.id, musicPrompt, duration)
      .then(async (musicId) => {
        logger.info(`Music generation initiated for story ${story.id}: ${musicId}`);
        await storyCompletionService.checkStoryCompletion(story.id);
      })
      .catch((err) => logger.error(`Music generation failed for story ${story.id}: ${err}`));

    // ✅ NEW safeguard: if no anchors are needed, start audio immediately
    const neededAnchors = await prisma.anchor.count({
      where: {
        story_id: story.id,
        appearances: { gte: 2 }
      }
    });

    if (neededAnchors === 0) {
      logger.info(`No anchor images needed for story ${story.id}. Starting audio generation now.`);

      speechService
        .generateAudioForStory(story.id, scriptData)
        .then(async () => {
          logger.info(`Audio generation finished for story ${story.id}`);
          
          // Update status to audio_completed when audio generation finishes
          await prisma.story.update({
            where: { id: story.id },
            data: { status: 'audio_completed' }
          });
          
          // Check story completion now that audio is ready
          await storyCompletionService.checkStoryCompletion(story.id);
        })
        .catch((err) => logger.error(`Audio generation failed for story ${story.id}: ${err}`));
    } else {
      logger.info(`Story ${story.id} requires ${neededAnchors} anchor images. Waiting for completion before audio.`);
    }

  } catch (error) {
    logger.error(`Error handling script completion: ${error}`);
    throw error;
  }
}

private async storeAnchors(storyId: string, scriptData: any): Promise<void> {
  // Store character anchors
  for (const character of scriptData.metadata.anchors.characters) {
    await prisma.anchor.create({
      data: {
        story_id: storyId,
        anchor_uuid: character.uuid,
        type: 'character',
        name: character.name,
        description: character.description,
        appearances: character.appearances,
        status: character.appearances >= 2 ? 'pending' : 'not_needed'
      }
    });
  }

  // Store setting anchors
  for (const setting of scriptData.metadata.anchors.settings) {
    await prisma.anchor.create({
      data: {
        story_id: storyId,
        anchor_uuid: setting.uuid,
        type: 'setting',
        name: setting.name,
        description: setting.description,
        appearances: setting.appearances,
        status: setting.appearances >= 2 ? 'pending' : 'not_needed'
      }
    });
  }

  logger.info(`Stored ${scriptData.metadata.anchors.characters.length} characters and ${scriptData.metadata.anchors.settings.length} settings for story ${storyId}`);
}

private async handleAnchorCompletion(responseId: string, responseData: OpenAIResponseData): Promise<void> {
  try {
    // Find the anchor with this response_id
    const anchor = await prisma.anchor.findFirst({
      where: { openai_response_id: responseId }
    });

    if (!anchor) {
      logger.warn(`Anchor not found for response: ${responseId}`);
      return;
    }

    logger.info(`Anchor image completed for: ${anchor.name} (${anchor.anchor_uuid})`);

    // Simply mark anchor as completed - no need to download/upload the image
    await prisma.anchor.update({
      where: { id: anchor.id },
      data: {
        status: 'completed',
        openai_response_id: responseId
      }
    });

    // Check if all anchor images are complete, then trigger audio generation
    await this.checkAndTriggerAudioGeneration(anchor.story_id);

  } catch (error) {
    logger.error(`Error handling anchor completion: ${error}`);
    
    // Mark anchor as failed
    const anchor = await prisma.anchor.findFirst({
      where: { openai_response_id: responseId }
    });
    
    if (anchor) {
      await prisma.anchor.update({
        where: { id: anchor.id },
        data: { status: 'failed' }
      });
    }
    
    throw error;
  }
}

private async checkAndTriggerAudioGeneration(storyId: string): Promise<void> {
  try {
    // Check if all required anchors are complete
    const requiredAnchors = await prisma.anchor.count({
      where: { story_id: storyId, appearances: { gte: 2 } }
    });

    const completedAnchors = await prisma.anchor.count({
      where: { story_id: storyId, appearances: { gte: 2 }, status: 'completed' }
    });

    if (completedAnchors < requiredAnchors) {
      logger.info(`Story ${storyId} still waiting for ${requiredAnchors - completedAnchors} anchor images`);
      return;
    }

    // All anchors are complete, check if audio hasn't started yet
    const story = await prisma.story.findUnique({
      where: { id: storyId },
      select: { status: true, transcript: true }
    });

    if (!story) {
      logger.warn(`Story not found: ${storyId}`);
      return;
    }

    if (story.status !== 'script_completed') {
      logger.info(`Story ${storyId} status is ${story.status}, waiting for script completion and anchor images`);
      return;
    }

    if (!story.transcript) {
      logger.warn(`Story ${storyId} has no transcript data`);
      return;
    }

    // Parse script data
    const scriptData = JSON.parse(story.transcript);

    logger.info(`All anchor images completed for story ${storyId}. Starting audio generation.`);

    // Fire-and-forget: kick off audio generation
    speechService
      .generateAudioForStory(storyId, scriptData)
      .then(async () => {
        logger.info(`Audio generation finished for story ${storyId}`);
        
        // Update status to audio_completed when audio generation finishes
        await prisma.story.update({
          where: { id: storyId },
          data: { status: 'audio_completed' }
        });
        
        // Check story completion now that audio is ready
        await storyCompletionService.checkStoryCompletion(storyId);
      })
      .catch((err) => logger.error(`Audio generation failed for story ${storyId}: ${err}`));

  } catch (error) {
    logger.error(`Error checking and triggering audio generation for story ${storyId}: ${error}`);
  }
}

private async handleImageCompletion(responseId: string, responseData: OpenAIResponseData): Promise<void> {
    try {
      // Delegate all image processing to ImageService
      await imageService.handleImageCompletion(responseId, responseData);
      
      // Get the story ID from the completed image to check story completion
      const image = await prisma.image.findUnique({
        where: { openai_response_id: responseId },
        select: { story_id: true }
      });
      
      if (image?.story_id) {
        // Check if story is now complete (all images + audio + music)
        await storyCompletionService.checkStoryCompletion(image.story_id);
      }
    } catch (error) {
      logger.error(`Error handling image completion: ${error}`);
      throw error;
    }
  }

// In ResponseService class
async handleCloudflareVideoReady(webhookData: any): Promise<void> {
  try {
    // Extract Cloudflare Stream UID
    const cloudflareId = webhookData.uid;
    if (!cloudflareId) {
      logger.error('No UID found in Cloudflare webhook');
      return;
    }
    
    // Extract HLS URL
    const hlsUrl = webhookData.playback?.hls;
    if (!hlsUrl) {
      logger.error('No HLS URL found in Cloudflare webhook');
      return;
    }
    
    // Find the story with this Cloudflare ID
    const story = await prisma.story.findFirst({
      where: { cloudflare_id: cloudflareId }
    });
    
    if (!story) {
      logger.error(`No story found with Cloudflare ID: ${cloudflareId}`);
      return;
    }
    
    // Update the story with the HLS URL and mark as fully completed
    const updatedStory = await prisma.story.update({
      where: { id: story.id },
      data: {
        video_url: hlsUrl,
        status: 'completed' // Final status - everything is done
      }
    });
    
    logger.info(`Story ${story.id} updated with HLS URL: ${hlsUrl}`);
    logger.info(`Story ${story.id} is now fully completed!`);
    
  } catch (error) {
    logger.error(`Error handling Cloudflare video ready webhook: ${error}`);
    throw error;
  }
}
}