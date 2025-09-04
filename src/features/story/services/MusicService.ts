import prisma from "../../../lib/prisma.js";
import axios from "axios";
import logger from "../../../utils/logger.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export class MusicService {
  private readonly ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/music";
  private s3Client: S3Client;

  constructor() {
    this.s3Client = new S3Client({
      endpoint: process.env.DO_SPACES_ENDPOINT!,
      region: process.env.DO_SPACES_REGION || "sfo3",
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY!,
        secretAccessKey: process.env.DO_SPACES_SECRET!,
      },
    });
  }

  private async uploadAudioToSpaces(audioBuffer: Buffer, musicId: string): Promise<string> {
    try {
      const fileName = `music/${musicId}.mp3`;
      
      const uploadCommand = new PutObjectCommand({
        Bucket: process.env.DO_SPACES_BUCKET!,
        Key: fileName,
        Body: audioBuffer,
        ContentType: "audio/mpeg",
        ACL: "public-read",
      });

      await this.s3Client.send(uploadCommand);

      const baseUrl =
        process.env.DO_SPACES_CDN_URL ||
        `https://${process.env.DO_SPACES_BUCKET}.${process.env.DO_SPACES_REGION}.digitaloceanspaces.com`;
      
      const publicUrl = `${baseUrl}/${fileName}`;
      logger.info(`Music uploaded to Spaces: ${publicUrl}`);
      
      return publicUrl;
    } catch (error) {
      logger.error(`Failed to upload music to Spaces: ${error}`);
      throw error;
    }
  }

  /**
   * Creates an ambient, low-key music prompt from the user's input
   * Ensures the music is suitable for background listening
   */
  private createAmbientPrompt(originalPrompt: string): string {
    // Define ambient music characteristics
    const ambientDescriptors = [
      "soft ambient",
      "gentle background",
      "subtle atmospheric",
      "quiet cinematic",
      "mellow instrumental",
      "peaceful ambient"
    ];

    // Choose a random ambient descriptor
    const ambientStyle = ambientDescriptors[Math.floor(Math.random() * ambientDescriptors.length)];

    // Create enhanced prompt with ambient constraints
    const enhancedPrompt = `${ambientStyle} music, ${originalPrompt.toLowerCase()}, ` +
      "low volume, no drums, no loud instruments, no vocals, minimal percussion, " +
      "background listening, contemplative, slow tempo, subtle textures, " +
      "gentle synthesizers, soft strings, ambient pads, peaceful atmosphere";

    logger.info(`Original prompt: "${originalPrompt}"`);
    logger.info(`Enhanced ambient prompt: "${enhancedPrompt}"`);

    return enhancedPrompt;
  }

  /**
   * Validates that the prompt doesn't contain upbeat or energetic terms
   */
  private validatePromptForAmbience(prompt: string): string {
    const energeticTerms = [
      'upbeat', 'energetic', 'fast', 'dance', 'rock', 'pop', 'hip-hop', 'rap',
      'electronic dance', 'edm', 'techno', 'house', 'disco', 'funk',
      'heavy drums', 'loud', 'aggressive', 'intense', 'powerful',
      'uplifting', 'exciting', 'dynamic', 'driving beat'
    ];

    let cleanedPrompt = prompt.toLowerCase();

    // Remove energetic terms and replace with ambient alternatives
    const replacements: Record<string, string> = {
      'upbeat': 'calm',
      'energetic': 'peaceful',
      'fast': 'slow',
      'loud': 'soft',
      'aggressive': 'gentle',
      'intense': 'subtle',
      'powerful': 'delicate',
      'exciting': 'soothing',
      'dynamic': 'flowing'
    };

    // Apply replacements
    Object.entries(replacements).forEach(([term, replacement]) => {
      cleanedPrompt = cleanedPrompt.replace(new RegExp(term, 'gi'), replacement);
    });

    // Remove any remaining energetic terms
    energeticTerms.forEach(term => {
      cleanedPrompt = cleanedPrompt.replace(new RegExp(term, 'gi'), '');
    });

    // Clean up extra spaces
    cleanedPrompt = cleanedPrompt.replace(/\s+/g, ' ').trim();

    return cleanedPrompt || 'peaceful ambient';
  }

  async generateMusic(
    storyId: string, 
    musicPrompt: string,
    duration: number
  ): Promise<string> {
    try {
      // Check if API key exists
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        throw new Error('ElevenLabs API key is not configured');
      }

      // Set fixed music length to 5 minutes (300000ms)
      const musicLengthMs = 300000;

      // Validate and enhance the prompt for ambient music
      const validatedPrompt = this.validatePromptForAmbience(musicPrompt);
      const ambientPrompt = this.createAmbientPrompt(validatedPrompt);

      logger.info(`Generating ambient music for story ${storyId}`);
      logger.info(`Using enhanced prompt: "${ambientPrompt}"`);

      // Call ElevenLabs Music API and wait for response
      const response = await axios.post(
        this.ELEVENLABS_API_URL,
        {
          music_length_ms: musicLengthMs,
          prompt: ambientPrompt
        },
        {
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer' // Audio data response
        }
      );

      // Generate a unique ID for this music
      const musicId = `music_${storyId}_${Date.now()}`;

      // Upload audio data to DigitalOcean Spaces
      const audioBuffer = Buffer.from(response.data);
      const audioUrl = await this.uploadAudioToSpaces(audioBuffer, musicId);

      // Save music record to database with audio URL
      const musicRecord = await prisma.music.create({
        data: {
          story_id: storyId,
          music_id: musicId,
          prompt: ambientPrompt, // Store the enhanced ambient prompt
          duration_ms: musicLengthMs,
          status: 'completed',
          audio_url: audioUrl
        }
      });

      logger.info(`Ambient music generation completed: ${musicRecord.id}, Audio URL: ${audioUrl}`);
      return musicId;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error(`ElevenLabs API Error: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`);
      } else {
        logger.error(`Failed to generate music: ${error}`);
      }
      throw new Error('Failed to generate music');
    }
  }

  async getMusicByStoryId(storyId: string): Promise<any> {
    try {
      const music = await prisma.music.findFirst({
        where: { story_id: storyId }
      });

      return music;
    } catch (error) {
      logger.error(`Failed to get music for story: ${error}`);
      throw error;
    }
  }

  async updateMusicStatus(musicId: string, status: string, audioUrl?: string): Promise<void> {
    try {
      await prisma.music.updateMany({
        where: { music_id: musicId },
        data: { 
          status,
          audio_url: audioUrl || null,
          updated_at: new Date()
        }
      });
      
      logger.info(`Updated music status for ${musicId}: ${status}`);
    } catch (error) {
      logger.error(`Failed to update music status: ${error}`);
      throw error;
    }
  }
}