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

    // ✅ Update the story with script data, but don't mark as fully completed yet
    await prisma.story.update({
      where: { id: story.id },
      data: {
        title: scriptData.title,
        transcript: JSON.stringify(scriptData), // Store full script as JSON
        status: 'script_completed' // ✅ Changed from 'completed'
      }
    });

    logger.info(`Story script completed: ${story.id}`);

    // Fire-and-forget: kick off audio generation
    speechService
      .generateAudioForStory(story.id, scriptData)
      .then(async () => {
        logger.info(`Audio generation finished for story ${story.id}`);
        
        // ✅ Update status to audio_completed when audio generation finishes
        await prisma.story.update({
          where: { id: story.id },
          data: { status: 'audio_completed' }
        });
        
        // ✅ Check story completion now that audio is ready
        await storyCompletionService.checkStoryCompletion(story.id);
      })
      .catch((err) => logger.error(`Audio generation failed for story ${story.id}: ${err}`));

    // Fire-and-forget: kick off music generation using story data
    const duration = typeof story.duration === 'string' ? parseInt(story.duration, 10) : story.duration;
    const musicPrompt = this.buildMusicPrompt(story.style, story.tone);
    musicService
      .generateMusic(story.id, musicPrompt, duration)
      .then(async (musicId) => {
        logger.info(`Music generation initiated for story ${story.id}: ${musicId}`);
        // ✅ Check if story is now complete (this will check audio + images + music)
        await storyCompletionService.checkStoryCompletion(story.id);
      })
      .catch((err) => logger.error(`Music generation failed for story ${story.id}: ${err}`));

    return;

  } catch (error) {
    logger.error(`Error handling script completion: ${error}`);
    throw error;
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
