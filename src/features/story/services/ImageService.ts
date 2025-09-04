import prisma from "../../../lib/prisma.js";
import axios from "axios";
import logger from "../../../utils/logger.js";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import type { EnhancedScript, Scene, OpenAIResponseData } from "../types/index.js";

export class ImageService {
  private s3Client: S3Client;

  constructor() {
    // Initialize Digital Ocean Spaces client (S3 compatible)
    this.s3Client = new S3Client({
      endpoint: process.env.DO_SPACES_ENDPOINT!, // Force non-undefined with !
      region: process.env.DO_SPACES_REGION || 'sfo3',
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY!,
        secretAccessKey: process.env.DO_SPACES_SECRET!
      }
    });
  }

  private async getAnchorRefsForScene(
    storyId: string,
    scene: any
  ): Promise<{ previousResponseIds: string[]; settingHint: string | null }> {
    // Gather UUIDs for characters and setting present in this scene
    const characterUuids: string[] = Array.isArray(scene?.characters)
      ? scene.characters.map((c: any) => c.uuid).filter(Boolean)
      : [];
    const settingUuid: string[] = scene?.setting?.uuid ? [scene.setting.uuid] : [];

    if (characterUuids.length === 0 && settingUuid.length === 0) {
      return { previousResponseIds: [], settingHint: null };
    }

    // Pull anchors just for the entities present in this scene
    const anchors = await prisma.anchor.findMany({
      where: {
        story_id: storyId,
        anchor_uuid: { in: [...characterUuids, ...settingUuid] },
      },
      select: {
        anchor_uuid: true,
        type: true, // 'character' | 'setting'
        name: true,
        description: true,
        appearances: true,
        status: true,
        openai_response_id: true,
      },
    });

    const previousResponseIds: string[] = [];
    let settingHint: string | null = null;

    for (const a of anchors) {
      const isCompletedAnchor =
        (a.appearances ?? 0) >= 2 && a.status === "completed" && !!a.openai_response_id;

      if (a.type === "character") {
        // Characters: 1 appearance = skipped entirely; 2+ = use as anchor
        if (isCompletedAnchor) {
          previousResponseIds.push(a.openai_response_id as string);
        }
      } else if (a.type === "setting") {
        if (isCompletedAnchor) {
          // Settings with 2+ appearances act as anchors
          previousResponseIds.push(a.openai_response_id as string);
        } else if ((a.appearances ?? 0) === 1) {
          // Settings with 1 appearance are injected into the prompt text only
          // Keep the hint concise to avoid over-instruction.
          settingHint = a.name; // or `${a.name}: ${a.description}` if you want richer context
        }
      }
    }

    return { previousResponseIds, settingHint };
  }

  // Generate anchor images for entities appearing 2+ times
  async generateAnchorImages(storyId: string, imageStyle: string): Promise<void> {
    try {
      // Get anchors that need image generation
      const anchorsToGenerate = await prisma.anchor.findMany({
        where: {
          story_id: storyId,
          appearances: { gte: 2 },
          status: 'pending'
        }
      });

      if (anchorsToGenerate.length === 0) {
        logger.info(`No anchor images needed for story ${storyId}`);
        return;
      }

      logger.info(`Generating ${anchorsToGenerate.length} anchor images for story ${storyId}`);

      // Generate image for each anchor
      for (const anchor of anchorsToGenerate) {
        await this.generateAnchorImage(storyId, anchor, imageStyle);
      }

    } catch (error) {
      logger.error(`Error generating anchor images for story ${storyId}: ${error}`);
      throw error;
    }
  }

  private async generateAnchorImage(
    storyId: string,
    anchor: any,
    imageStyle: string
  ): Promise<void> {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured');
      }

      // Build prompt from anchor name, description and style
      const styledPrompt = `${anchor.name}: ${anchor.description}, ${imageStyle} style, no text or captions visible`;

      logger.info(`Generating anchor image for: ${anchor.name} (${anchor.anchor_uuid})`);

      // Call OpenAI image generation
      const response = await axios.post(
        'https://api.openai.com/v1/responses',
        {
          model: 'gpt-5-nano',
          tools: [
            {
              type: 'image_generation',
              size: '1536x1024', // 16:9
            },
          ],
          input: styledPrompt,
          background: true,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const openaiResponse = response.data;

      // Update anchor record with response ID
      await prisma.anchor.update({
        where: { id: anchor.id },
        data: {
          openai_response_id: openaiResponse.id,
          status: 'processing'
        }
      });

      // Track response for webhook completion
      await prisma.response.create({
        data: {
          response_id: openaiResponse.id,
          type: 'anchor'
        }
      });

      logger.info(`Anchor image generation initiated for ${anchor.name}, response ID: ${openaiResponse.id}`);
    } catch (error) {
      logger.error(`Error generating anchor image for ${anchor.name}: ${error}`);
      
      // Mark anchor as failed
      await prisma.anchor.update({
        where: { id: anchor.id },
        data: { status: 'failed' }
      });
      
      throw error;
    }
  }

  // Updated method: Generate images using dynamic shot prompts with durations
  async generateImagesForScene(
    storyId: string, 
    scene: any, 
    actualDuration: number, 
    imageStyle: string,
    shotData: {shot: number, duration: number, prompt: string}[]
  ): Promise<void> {
    try {
      logger.info(`Starting image generation for scene ${scene.id}, duration: ${actualDuration}s, shots: ${shotData.length}`);
      
      // Resolve anchor references (2+ appearances) and one-off setting hint for this scene
      const { previousResponseIds, settingHint } = await this.getAnchorRefsForScene(storyId, scene);

      // Generate one image for each shot with its specific duration
      const imagePromises = shotData.map((shotInfo) =>
        this.generateImageForShot(
          storyId,
          scene.id,
          shotInfo.prompt,
          shotInfo.shot,
          imageStyle,
          shotInfo.duration,
          { previousResponseIds, settingHint }
        )
      );

      await Promise.all(imagePromises);

      logger.info(`Generated ${shotData.length} images for scene: ${scene.id}`);
    } catch (error) {
      logger.error(`Error generating images for scene ${scene.id}: ${error}`);
      throw error;
    }
  }

  // Generate a single image for a given shot with specific duration
  private async generateImageForShot(
    storyId: string,
    sceneId: string,
    shotPrompt: string,
    shotNumber: number,
    imageStyle: string,
    shotDuration: number,
    opts?: { previousResponseIds?: string[]; settingHint?: string | null }
  ): Promise<void> {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured');
      }

      // Use the shot prompt as-is since it's already styled by OpenAI
      // Only add setting hint and explicit no-text instruction
      const finalPrompt = opts?.settingHint
        ? `${shotPrompt}. Environment: ${opts.settingHint}. No text, captions, or written words visible in the image.`
        : `${shotPrompt}. No text, captions, or written words visible in the image.`;

      logger.info(`Generating shot ${shotNumber} for scene ${sceneId} (${shotDuration}s): using OpenAI-styled prompt`);

      // Prepare payload for OpenAI API
      const payload: any = {
        model: 'gpt-5-nano',
        tools: [
          {
            type: 'image_generation',
            size: '1536x1024', // 16:9
          },
        ],
        input: finalPrompt, // Don't add imageStyle again - it's already in the shot prompt
        background: true,
      };

      // If previousResponseIds exist, add previous_response_id at root and add instructions
      if (opts?.previousResponseIds && opts.previousResponseIds.length > 0) {
        // Use the first previous response ID as anchor
        payload.previous_response_id = opts.previousResponseIds[0];
        payload.instructions = "Using the previous image generated as an anchor reference for character and setting consistency.";
      }

      const response = await axios.post(
        'https://api.openai.com/v1/responses',
        payload,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const openaiResponse = response.data;

      // Create image record for this shot with duration
      await prisma.image.create({
        data: {
          story_id: storyId,
          scene_id: sceneId,
          shot_number: shotNumber,
          duration: shotDuration,
          image_prompt: finalPrompt,
          openai_response_id: openaiResponse.id,
          status: 'processing',
        },
      });

      // Track response for webhook/async completion
      await prisma.response.create({
        data: {
          response_id: openaiResponse.id,
          type: 'image',
        },
      });

      logger.info(`Shot image generation initiated for scene ${sceneId}, shot #${shotNumber} (${shotDuration}s)`);
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        logger.error(`Error generating shot image for scene ${sceneId}, shot #${shotNumber}`);
        logger.error(`Status: ${error.response?.status}`);
        logger.error(`Response data: ${JSON.stringify(error.response?.data)}`);
        logger.error(`Request data: ${JSON.stringify(error.config?.data)}`);
      } else {
        logger.error(`Unexpected error generating shot image for scene ${sceneId}, shot #${shotNumber}: ${error}`);
      }
      throw error;
    }
  }

  async handleImageCompletion(responseId: string, responseData: OpenAIResponseData): Promise<void> {
    try {
      // Find the image record with this response_id
      const image = await prisma.image.findUnique({
        where: { openai_response_id: responseId }
      });

      if (!image) {
        logger.warn(`Image not found for response: ${responseId}`);
        return;
      }

      logger.info(`Processing image completion for scene: ${image.scene_id}, shot: ${image.shot_number}`);

      // Extract base64 image from OpenAI response
      const imageData = this.extractImageFromResponse(responseData);
      if (!imageData) {
        throw new Error('No image data found in OpenAI response');
      }

      // Process and upload the image
      const imageUrl = await this.processAndUploadImage(imageData, image.scene_id, image.story_id, image.shot_number);

      // Update the image record
      await prisma.image.update({
        where: { id: image.id },
        data: {
          image_url: imageUrl,
          status: 'completed'
        }
      });

      logger.info(`Image completed for scene: ${image.scene_id}, shot: ${image.shot_number}, URL: ${imageUrl}`);

      // Check if all images for this scene are complete
      await this.checkSceneImageCompletion(image.story_id, image.scene_id);
    } catch (error) {
      logger.error(`Error handling image completion: ${error}`);
      
      // Mark image as failed
      const image = await prisma.image.findUnique({
        where: { openai_response_id: responseId }
      });
      
      if (image) {
        await prisma.image.update({
          where: { id: image.id },
          data: { status: 'failed' }
        });
      }
      
      throw error;
    }
  }

  private async checkSceneImageCompletion(storyId: string, sceneId: string): Promise<void> {
    try {
      const sceneImages = await prisma.image.findMany({
        where: {
          story_id: storyId,
          scene_id: sceneId
        },
        orderBy: { shot_number: 'asc' }
      });

      const completedImages = sceneImages.filter(img => img.status === 'completed');
      const failedImages = sceneImages.filter(img => img.status === 'failed');

      if (completedImages.length + failedImages.length === sceneImages.length) {
        logger.info(`Scene ${sceneId} image generation complete: ${completedImages.length} successful, ${failedImages.length} failed`);
        
        // Optionally update scene status or trigger next workflow step
        // await this.triggerVideoGeneration(storyId, sceneId);
      }
    } catch (error) {
      logger.error(`Error checking scene image completion: ${error}`);
    }
  }

  private extractImageFromResponse(responseData: OpenAIResponseData): string | null {
    try {
      logger.info('Attempting to extract image from response...');
      const outputs = Array.isArray(responseData.output) ? responseData.output : [];
      logger.info(`Response output array length: ${outputs.length}`);

      // Log output types for debugging
      outputs.forEach((output: any, index: number) => {
        logger.info(`Output ${index}: type=${output.type}, id=${output.id}`);
      });

      // Look for image_generation_call in the response output
      const imageGeneration = outputs.find((output: any) => output.type === "image_generation_call");
      if (imageGeneration) {
        logger.info(`Found image_generation_call: ${imageGeneration.id}`);
        logger.info(`Image generation status: ${imageGeneration.status}`);
        if (typeof imageGeneration.result === "string") {
          logger.info(`Extracted base64 result of length: ${imageGeneration.result.length}`);
          return imageGeneration.result;
        }
      }

      logger.warn("No image data found in any expected location");
      return null;
    } catch (error) {
      logger.error(`Error extracting image from response: ${error}`);
      return null;
    }
  }

  private async processAndUploadImage(
    base64Data: string, 
    sceneId: string, 
    storyId: string, 
    shotNumber?: number
  ): Promise<string> {
    try {
      // Convert base64 to buffer
      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Compress the image using Sharp
      const compressedBuffer = await sharp(imageBuffer)
        .jpeg({ 
          quality: 85, 
          progressive: true 
        })
        .resize(1024, 1024, { 
          fit: 'inside',
          withoutEnlargement: true 
        })
        .toBuffer();

      // Generate unique filename with shot number
      const timestamp = Date.now();
      const hash = crypto.createHash('md5').update(sceneId + storyId + (shotNumber || '')).digest('hex').substring(0, 8);
      const shotSuffix = shotNumber ? `_shot${shotNumber}` : '';
      const fileName = `images/${storyId}/${sceneId}${shotSuffix}_${timestamp}_${hash}.jpg`;

      // Upload to Digital Ocean Spaces
      const uploadCommand = new PutObjectCommand({
        Bucket: process.env.DO_SPACES_BUCKET!,
        Key: fileName,
        Body: compressedBuffer,
        ContentType: 'image/jpeg',
        ACL: 'public-read'
      });

      await this.s3Client.send(uploadCommand);

      // Construct the public URL
      const baseUrl = process.env.DO_SPACES_CDN_URL || `https://${process.env.DO_SPACES_BUCKET}.${process.env.DO_SPACES_REGION}.digitaloceanspaces.com`;
      const publicUrl = `${baseUrl}/${fileName}`;

      logger.info(`Image uploaded successfully: ${publicUrl}`);
      return publicUrl;

    } catch (error) {
      logger.error(`Error processing and uploading image: ${error}`);
      throw error;
    }
  }
}