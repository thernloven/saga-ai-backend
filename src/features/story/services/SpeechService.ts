import prisma from "../../../lib/prisma.js";
import axios from "axios";
import logger from "../../../utils/logger.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import type { EnhancedScript } from "../types/index.js";
import { ImageService } from "./ImageService.js";

const imageService = new ImageService();

export class SpeechService {
  private s3Client: S3Client;
  private readonly MAX_CONCURRENT_CALLS = 10;
  private mixingChecks = new Set<string>();

  constructor() {
    this.s3Client = new S3Client({
      endpoint: process.env.DO_SPACES_ENDPOINT!,
      region: process.env.DO_SPACES_REGION || "sfo3",
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY!,
        secretAccessKey: process.env.DO_SPACES_SECRET!,
      }
    });
  }

  /**
   * Generate subtitles using ElevenLabs speech-to-text
   */
  private async generateSubtitles(audioBuffer: Buffer): Promise<any> {
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        throw new Error('ElevenLabs API key not configured');
      }

      logger.info('Generating subtitles from final audio...');

      // Create form data for the API using ES module compatible approach
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('file', audioBuffer, {
        filename: 'audio.mp3',
        contentType: 'audio/mpeg'
      });
      form.append('model_id', 'scribe_v1');

      const response = await axios.post(
        'https://api.elevenlabs.io/v1/speech-to-text',
        form,
        {
          headers: {
            'xi-api-key': apiKey,
            ...form.getHeaders()
          }
        }
      );

      const subtitleData = response.data;
      logger.info(`Subtitles generated: ${subtitleData.words?.length || 0} words, ${subtitleData.language_code} (${(subtitleData.language_probability * 100).toFixed(1)}% confidence)`);

      return subtitleData;

    } catch (error) {
      logger.error(`Error generating subtitles: ${error}`);
      // Don't fail the entire process if subtitles fail
      return { 
        text: '', 
        words: [], 
        language_code: 'en', 
        language_probability: 0 
      };
    }
  }

  async generateAudioForStory(storyId: string, scriptData: EnhancedScript): Promise<void> {
    try {
      logger.info(`Starting scene-by-scene audio generation for story: ${storyId}`);
      logger.info(`Total scenes to process: ${scriptData.scenes.length}`);

      // Process all scenes concurrently (capped by MAX_CONCURRENT_CALLS)
      await this.processScenesWithConcurrency(storyId, scriptData);

      logger.info(`Audio generation initiated for ${scriptData.scenes.length} scenes`);
    } catch (error) {
      logger.error(`Error generating audio for story: ${error}`);
      throw error;
    }
  }

  private async processScenesWithConcurrency(storyId: string, scriptData: EnhancedScript): Promise<void> {
    let activeRequests = 0;
    const maxConcurrent = this.MAX_CONCURRENT_CALLS;

    const processScene = async (scene: any, sceneIndex: number): Promise<void> => {
      // Wait for available slot
      while (activeRequests >= maxConcurrent) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      activeRequests++;

      try {
        await this.generateAudioForScene(
          storyId,
          scene,
          sceneIndex + 1,
          scriptData.metadata.imageStyle
        );
      } catch (error) {
        logger.error(`Error processing scene ${scene.id}: ${error}`);
        await this.updateSceneStatus(storyId, scene.id, "failed");
      } finally {
        activeRequests--;
      }
    };

    // Process all scenes
    const scenePromises = scriptData.scenes.map((scene, index) => processScene(scene, index));
    await Promise.allSettled(scenePromises);
  }

  private async generateAudioForScene(
    storyId: string,
    scene: any,
    sceneNumber: number,
    imageStyle: string
  ): Promise<void> {
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        throw new Error("ElevenLabs API key not configured");
      }

      logger.info(`Generating audio for scene: ${scene.id} (${scene.inputs.length} inputs)`);

      // Create audio segment record
      await prisma.audioSegment.create({
        data: {
          story_id: storyId,
          scene_id: scene.id,
          scene_number: sceneNumber,
          text_content: JSON.stringify(scene.inputs),
          character_count: scene.inputs.reduce((total: number, input: any) => total + (input.text?.length || 0), 0),
          status: "pending",
        },
      });

      // Call ElevenLabs API for entire scene
      const response = await axios.post(
        "https://api.elevenlabs.io/v1/text-to-dialogue",
        {
          inputs: scene.inputs.map((input: any) => ({
            text: input.text,
            voice_id: input.voice_id,
          })),
        },
        {
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          responseType: "arraybuffer",
        }
      );

      const audioBuffer = Buffer.from(response.data);

      // Upload audio to Digital Ocean Spaces
      const audioUrl = await this.uploadSceneAudio(audioBuffer, storyId, scene.id);

      // Get actual audio duration using ffprobe
      const actualDuration = await this.getAudioDuration(audioBuffer);

      // Update database with audio info
      await this.updateSceneWithAudio(storyId, scene.id, audioUrl, actualDuration);

      logger.info(`Scene audio completed: ${scene.id}, actual duration: ${actualDuration}s`);

      // NEW: Generate dynamic image shots based on actual duration
      await this.generateDynamicImageShots(storyId, scene, actualDuration, imageStyle);

      // Check if all scenes are complete for final mixing
      await this.checkAndTriggerMixing(storyId);
    } catch (error) {
      this.logAxiosError(`Error generating audio for scene ${scene.id}`, error);
      throw error;
    }
  }

  private logAxiosError(context: string, error: any, extra?: Record<string, any>) {
    try {
      const err: any = error;
      const status = err?.response?.status;
      const statusText = err?.response?.statusText;
      const headers = err?.response?.headers || {};
      let data = err?.response?.data;

      // Decode ArrayBuffer/Buffer bodies to UTF-8 so JSON from ElevenLabs is readable
      try {
        if (data && (data instanceof ArrayBuffer || Buffer.isBuffer(data))) {
          data = Buffer.from(data as any).toString("utf8");
        }
        if (typeof data !== "string") {
          data = JSON.stringify(data);
        }
      } catch {}

      const requestId = headers["x-request-id"] || headers["request-id"] || headers["x-amzn-requestid"] || headers["x-amz-request-id"] || "N/A";
      const info = {
        status,
        statusText,
        requestId,
        url: err?.config?.url,
        method: err?.config?.method,
        // Do NOT log credentials/headers; keep body visibility minimal but helpful
      };

      logger.error(`${context}: HTTP ${status ?? "N/A"} ${statusText ?? ""} reqId=${requestId}`);
      logger.error(`${context} details: info=${JSON.stringify(info)} body=${data ?? "N/A"}`);
    } catch (fallback) {
      logger.error(`${context}: ${error}`);
    }
  }

  private async generateDynamicImageShots(
    storyId: string,
    scene: any,
    actualDuration: number,
    imageStyle: string
  ): Promise<void> {
    try {
      // Calculate number of shots needed (one every 5 seconds, minimum 1)
      const shotsNeeded = Math.max(1, Math.ceil(actualDuration / 5));

      logger.info(`Scene ${scene.id}: ${actualDuration}s duration requires ${shotsNeeded} image shots`);

      // Calculate shot durations array (all 5s except possibly last shot)
      const shotDurations: number[] = [];
      let remaining = actualDuration;
      for (let i = 0; i < shotsNeeded; i++) {
        // For all but last, use 5s
        if (i < shotsNeeded - 1) {
          shotDurations.push(5);
          remaining -= 5;
        } else {
          // Last shot gets the remainder (minimum 1s)
          shotDurations.push(Math.max(1, Math.round(remaining)));
        }
      }

      // Generate dialogue-aware shot prompts using OpenAI
      const shotPrompts = await this.generateShotPrompts(
        scene.image_prompt,
        scene.inputs,
        shotsNeeded,
        {
          setting: scene.setting,
          characters: scene.characters
        },
        shotDurations,
        actualDuration
      );

      // Pass the generated prompts to ImageService
      await imageService.generateImagesForScene(storyId, scene, actualDuration, imageStyle, shotPrompts);

    } catch (error) {
      logger.error(`Error generating dynamic image shots for scene ${scene.id}: ${error}`);
      throw error;
    }
  }

  private async generateShotPrompts(
    sceneDescription: string,
    sceneDialogue: any[],
    shotsNeeded: number,
    context?: {
      setting?: { name?: string; uuid?: string; description?: string };
      characters?: Array<{ name?: string; uuid?: string; description?: string; appearances?: number }>;
    },
    targetDurations?: number[],
    sceneDuration?: number
  ): Promise<{ shot: number; duration: number; prompt: string }[]> {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key not configured');
      }

      logger.info(`Generating ${shotsNeeded} dialogue-aware shot prompts for scene`);

      // Build scene context (setting, characters, temporal anchor) to lock era and place
      const settingName = context?.setting?.name?.trim();
      const settingDesc = context?.setting?.description?.trim();
      const characterNames = Array.isArray(context?.characters)
        ? (context!.characters || []).map((c: any) => c?.name).filter(Boolean)
        : [];

      // Try to derive a temporal anchor from dialogue (e.g., "March 15, 44 BCE")
      const allDialogueText = sceneDialogue.map((d: any) => d?.text || "").join(" \n ");
      const dateWithEraMatch = allDialogueText.match(/\b([A-Z][a-z]+\s+\d{1,2},\s*\d{1,4}\s*(BCE|BC|CE|AD))\b/i);
      const bareEraMatch = allDialogueText.match(/\b(\d{1,4})\s*(BCE|BC|CE|AD)\b/i);
      const temporalAnchor = (dateWithEraMatch && dateWithEraMatch[1]) || (bareEraMatch && bareEraMatch[0]) || null;

      const contextPreamble = [
        `Setting: ${settingName || 'Unknown'}` + (settingDesc ? ` — ${settingDesc}` : ''),
        `Characters in scene: ${characterNames.length ? characterNames.join(', ') : '—'}`,
        `Era/Date: ${temporalAnchor || '—'}`
      ].join('\n');

      // Build dialogue context for the AI
      const dialogueContext = sceneDialogue.map((input, index) =>
        `${index + 1}. "${input.text}" (${input.text.length} characters)`
      ).join('\n');

      const response = await axios.post(
        'https://api.openai.com/v1/responses',
        {
          model: "gpt-5-nano",
          instructions:
            `Scene total duration: ${sceneDuration} seconds.\n` +
            `Shot durations (in order): [${targetDurations?.join(', ') || ''}]\n\n` +
            `Create ${shotsNeeded} cinematic shots for this scene using the dialogue and context below. STRICTLY follow these rules:\n\n` +
            `- Era & Place Lock: All shots must be faithful to the historical context indicated by the setting and date. Do NOT include modern clothing, props, architecture, tech, or lighting. Favor materials like marble, travertine, bronze, oil lamps, togas, etc., when Roman context is implied.\n` +
            `- Dialogue Alignment: Each shot must visualize or support a specific dialogue beat. In the prompt, reference the dialogue line number using (line X).\n` +
            `- Visual Variety: Important beats may get multiple angles; include establishing or atmospheric shots for pacing when helpful.\n` +
            `- Durations: Each shot’s duration must exactly match the provided array, in order. (Shot 1 = first value, Shot 2 = second value, etc.)\n` +
            `- Style: Respect the scene style and mood.\n` +
            `- Prompt Prefix: Begin each shot prompt with a short tag of the form [Setting: <name> | Era: <value>] using the provided context (if era/date is unknown, infer plausibly from setting).\n\n` +
            `Return shots that combine the scene style with the specific dialogue content and adhere to historical plausibility. Return as JSON with a "shots" array of objects { shot, duration, prompt }.`,
          input: `Scene Style: ${sceneDescription}\n\nContext:\n${contextPreamble}\n\nDialogue (numbered):\n${dialogueContext}`,
          text: {
            format: {
              type: "json_schema",
              name: "shot_prompts",
              schema: {
                type: "object",
                properties: {
                  shots: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        shot: { type: "number" },
                        duration: { type: "number" },
                        prompt: { type: "string" }
                      },
                      required: ["shot", "duration", "prompt"],
                      additionalProperties: false
                    },
                    minItems: shotsNeeded,
                    maxItems: shotsNeeded
                  }
                },
                required: ["shots"],
                additionalProperties: false
              },
              strict: true
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // Just wait for the response - it takes ~20 seconds
      await new Promise(resolve => setTimeout(resolve, 20000));

      // The response should be ready now - extract the shots
      const responseData = response.data;
      if (responseData.output && responseData.output.length > 0) {
        const messageOutput = responseData.output.find((output: any) => output.type === 'message');
        if (messageOutput && messageOutput.content && messageOutput.content.length > 0) {
          const textContent = messageOutput.content.find((content: any) => content.type === 'output_text');
          if (textContent && textContent.text) {
            const parsed = JSON.parse(textContent.text);
            if (parsed.shots && Array.isArray(parsed.shots) && parsed.shots.length >= shotsNeeded) {
              logger.info(`Successfully generated ${parsed.shots.length} dialogue-aware shot prompts from OpenAI`);
              return parsed.shots.slice(0, shotsNeeded);
            }
          }
        }
      }

      throw new Error('Could not extract shot prompts from OpenAI response');

    } catch (error) {
      logger.error(`Error generating dialogue-aware shot prompts: ${error}`);
      
      // Fallback: generate descriptive variations with smart durations (5 or 10 seconds only)
      const fallbackPrompts: {shot: number, duration: number, prompt: string}[] = [];
      const variations = [
        { type: "wide establishing shot", duration: 10 },
        { type: "medium shot with dramatic lighting", duration: 5 }, 
        { type: "close-up detail shot", duration: 5 },
        { type: "low angle perspective", duration: 10 },
        { type: "high angle overview", duration: 10 },
        { type: "side profile composition", duration: 5 },
        { type: "shallow depth of field focus", duration: 5 },
        { type: "atmospheric wide shot", duration: 10 },
        { type: "tight framing on key elements", duration: 5 }
      ];
      
      for (let i = 1; i <= shotsNeeded; i++) {
        const variationIndex = (i - 1) % variations.length;
        const variation = variations[variationIndex]!;
        fallbackPrompts.push({
          shot: i,
          duration: variation.duration,
          prompt: `${sceneDescription}, ${variation.type}`
        });
      }
      
      logger.info(`Using fallback prompts: ${fallbackPrompts.length} variations`);
      return fallbackPrompts;
    }
  }

  private async uploadSceneAudio(audioBuffer: Buffer, storyId: string, sceneId: string): Promise<string> {
    try {
      const timestamp = Date.now();
      const hash = crypto
        .createHash("md5")
        .update(storyId + sceneId)
        .digest("hex")
        .substring(0, 8);
      const fileName = `audio/${storyId}/${sceneId}_${timestamp}_${hash}.mp3`;

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
      return `${baseUrl}/${fileName}`;
    } catch (error) {
      logger.error(`Error uploading scene audio: ${error}`);
      throw error;
    }
  }

  private async updateSceneStatus(storyId: string, sceneId: string, status: string): Promise<void> {
    await prisma.audioSegment.updateMany({
      where: {
        story_id: storyId,
        scene_id: sceneId,
      },
      data: { status },
    });
  }

  private async updateSceneWithAudio(
    storyId: string,
    sceneId: string,
    audioUrl: string,
    duration: number
  ): Promise<void> {
    await prisma.audioSegment.updateMany({
      where: {
        story_id: storyId,
        scene_id: sceneId,
      },
      data: {
        audio_url: audioUrl,
        scene_duration: duration,
        status: "completed",
      },
    });
  }

  private async checkAndTriggerMixing(storyId: string): Promise<void> {
    if (this.mixingChecks.has(storyId)) return;

    this.mixingChecks.add(storyId);

    try {
      const segments = await prisma.audioSegment.findMany({
        where: { story_id: storyId },
        orderBy: { scene_number: "asc" },
      });

      const completedSegments = segments.filter((segment) => segment.status === "completed");

      if (completedSegments.length === segments.length && segments.length > 0) {
        logger.info(`All scene audio completed for story ${storyId}. Ready for mixing.`);

        await prisma.story.update({
          where: { id: storyId },
          data: { status: "audio_ready" },
        });

        await this.mixAudioSegments(storyId, completedSegments as any[]);
      }
    } catch (error) {
      logger.error(`Error checking mixing status: ${error}`);
    } finally {
      this.mixingChecks.delete(storyId);
    }
  }

  private async mixAudioSegments(storyId: string, segments: any[]): Promise<void> {
    const tempDir = path.join(process.cwd(), "temp", storyId);

    try {
      logger.info(`Starting audio mixing for story: ${storyId}`);

      fs.mkdirSync(tempDir, { recursive: true });

      const audioFiles: string[] = [];
      for (const segment of segments.sort((a, b) => a.scene_number - b.scene_number)) {
        const filePath = await this.downloadAudioSegment(segment, tempDir);
        audioFiles.push(filePath);
      }

      const finalAudioPath = path.join(tempDir, "final_audio.mp3");
      await this.concatenateAudioFiles(audioFiles, finalAudioPath, tempDir);

      const finalAudioBuffer = fs.readFileSync(finalAudioPath);
      const finalAudioUrl = await this.uploadFinalAudio(finalAudioBuffer, storyId);

      // Generate subtitles from the final audio
      const subtitles = await this.generateSubtitles(finalAudioBuffer);

      await prisma.story.update({
        where: { id: storyId },
        data: {
          audio_url: finalAudioUrl,
          subtitles: JSON.stringify(subtitles),
          status: "audio_completed",
        },
      });

      logger.info(`Audio mixing completed for story: ${storyId}, URL: ${finalAudioUrl}`);

      // Check if story is now complete (all components ready)
      const { StoryCompletionService } = await import("../../events/StoryCompletionService.js");
      const storyCompletionService = new StoryCompletionService();
      await storyCompletionService.checkStoryCompletion(storyId);

    } catch (error) {
      logger.error(`Error mixing audio segments: ${error}`);

      await prisma.story.update({
        where: { id: storyId },
        data: { status: "audio_failed" },
      });

      throw error;
    } finally {
      await this.cleanupTempDirectory(tempDir);
    }
  }

  private async downloadAudioSegment(segment: any, tempDir: string): Promise<string> {
    try {
      const response = await axios.get(segment.audio_url, {
        responseType: "arraybuffer",
      });

      const fileName = `scene_${segment.scene_number}.mp3`;
      const filePath = path.join(tempDir, fileName);

      fs.writeFileSync(filePath, Buffer.from(response.data));
      logger.info(`Downloaded scene audio: ${fileName}`);

      return filePath;
    } catch (error) {
      logger.error(`Error downloading scene audio ${segment.scene_id}: ${error}`);
      throw error;
    }
  }

  private async concatenateAudioFiles(
    inputFiles: string[],
    outputPath: string,
    tempDir: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = ffmpeg();

      inputFiles.forEach((file) => {
        command.addInput(file);
      });

      command
        .on("start", (commandLine) => {
          logger.info(`FFmpeg started: ${commandLine}`);
        })
        .on("progress", (progress) => {
          logger.info(`Processing: ${Math.round(progress.percent || 0)}% done`);
        })
        .on("end", () => {
          logger.info("Audio concatenation completed successfully");
          resolve();
        })
        .on("error", (err) => {
          logger.error(`FFmpeg error: ${err.message}`);
          reject(err);
        })
        .mergeToFile(outputPath, tempDir);
    });
  }

  private async uploadFinalAudio(audioBuffer: Buffer, storyId: string): Promise<string> {
    try {
      const timestamp = Date.now();
      const hash = crypto
        .createHash("md5")
        .update(storyId + "final")
        .digest("hex")
        .substring(0, 8);
      const fileName = `audio/${storyId}/final_${timestamp}_${hash}.mp3`;

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

      logger.info(`Final audio uploaded successfully: ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      logger.error(`Error uploading final audio: ${error}`);
      throw error;
    }
  }

  private async getAudioDuration(audioBuffer: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      // Ensure temp folder exists
      const tempRoot = path.join(process.cwd(), "temp");
      try {
        fs.mkdirSync(tempRoot, { recursive: true });
      } catch {}

      // Create temporary file to analyze
      const tempFile = path.join(tempRoot, `temp_audio_${Date.now()}.mp3`);

      try {
        // Write buffer to temporary file
        fs.writeFileSync(tempFile, audioBuffer);

        // Use ffprobe to get duration
        ffmpeg.ffprobe(tempFile, (err, metadata) => {
          // Clean up temp file
          try {
            fs.unlinkSync(tempFile);
          } catch (cleanupError) {
            logger.warn(`Failed to cleanup temp file: ${cleanupError}`);
          }

          if (err) {
            logger.error(`Error getting audio duration: ${err}`);
            reject(err);
          } else {
            const duration = (metadata as any)?.format?.duration || 0;
            resolve(duration);
          }
        });
      } catch (error) {
        // Clean up temp file if error occurs
        try {
          fs.unlinkSync(tempFile);
        } catch (cleanupError) {
          logger.warn(`Failed to cleanup temp file after error: ${cleanupError}`);
        }
        reject(error);
      }
    });
  }

  private async cleanupTempDirectory(tempDir: string): Promise<void> {
    try {
      // Use rm with recursive + force to avoid EBUSY / ENOENT noise
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      logger.info(`Cleaned up temporary directory: ${tempDir}`);
    } catch (error) {
      logger.error(`Error cleaning up temp directory: ${error}`);
    }
  }
}