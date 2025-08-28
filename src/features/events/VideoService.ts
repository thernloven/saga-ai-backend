import prisma from "../../lib/prisma.js";
import axios from "axios";
import logger from "../../utils/logger.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";

import type { SceneData, ImageData, VideoAssets } from "./types/index.js";

// ---- Timing constants (single source of truth) ----
const INTRO_FADE_SEC = 5;        // fade-in duration for audio/music
const OUTRO_FADE_SEC = 10;       // video/music fade-out length
// Visual/audio pre-roll before voice starts
const INTRO_PAD_SEC = 5;         // seconds of image+music before voice

// ---- Output frame geometry ----
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
// Choose how 3:2 images (e.g., 1536x1024) fit into 16:9 output:
//  - 'pad'   : letterbox (no crop, black bars)
//  - 'cover' : center-crop to fill frame (no bars)
const VIDEO_FIT_MODE = (process.env.VIDEO_FIT_MODE || 'cover').toLowerCase();

export class VideoService {
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

  /**
   * Main method to generate video for a completed story
   */
  async generateVideo(storyId: string): Promise<string> {
    const tempDir = path.join(process.cwd(), "temp", `video_${storyId}`);

    try {
      logger.info(`Starting video generation for story: ${storyId}`);

      // Create temp directory
      fs.mkdirSync(tempDir, { recursive: true });

      // 1. Collect all video assets
      const assets = await this.collectVideoAssets(storyId);

      // 2. Download all assets to temp directory
      await this.downloadAssets(assets, tempDir);

      // 3. Get actual audio duration
      const audioDuration = await this.getAudioDuration(assets.finalAudioPath!);
      logger.info(`Voice audio duration: ${audioDuration}s`);

      // 4. Calculate timing for each image
      const imageTiming = this.calculateImageTiming(assets.scenes, audioDuration);

      // 5. Process music (loop, trim, fade)
      const processedMusicPath = await this.processMusicForVideo(
        assets.musicPath!,
        imageTiming.totalDuration,
        tempDir
      );

      // 6. Generate video using FFmpeg (no subtitles)
      const videoPath = await this.createVideo(
        assets,
        imageTiming,
        processedMusicPath,
        tempDir
      );

      // 7. Upload final video to Spaces
      const videoUrl = await this.uploadVideo(videoPath, storyId);

      // 8. Update story with video URL and status
      await prisma.story.update({
        where: { id: storyId },
        data: { 
          video_url: videoUrl,
          status: 'do_completed'
        }
      });

      // 9. Upload to Cloudflare Stream
      await this.uploadToCloudflareStream(videoUrl, storyId);

      logger.info(`Video generation completed: ${storyId}, URL: ${videoUrl}`);
      return videoUrl;

    } catch (error) {
      logger.error(`Error generating video for story ${storyId}: ${error}`);
      throw error;
    } finally {
      // Cleanup temp directory
      await this.cleanupTempDirectory(tempDir);
    }
  }

  /**
   * Get actual duration of audio file using ffprobe
   */
  private async getAudioDuration(audioPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) {
          reject(err);
        } else {
          const duration = metadata.format.duration || 0;
          resolve(duration);
        }
      });
    });
  }

  /**
   * Upload video to Cloudflare Stream
   */
  private async uploadToCloudflareStream(videoUrl: string, storyId: string): Promise<void> {
    try {
      const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const cloudflareToken = process.env.CLOUDFLARE_TOKEN;

      if (!cloudflareAccountId || !cloudflareToken) {
        logger.warn('Cloudflare credentials not configured, skipping Stream upload');
        return;
      }

      const cloudflareUrl = `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/stream/copy`;

      const response = await axios.post(
        cloudflareUrl,
        {
          url: videoUrl,
          meta: {
            name: storyId
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${cloudflareToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.success) {
        const cloudflareStreamId = response.data.result.uid;
        
        // Save the Cloudflare Stream ID to the database
        await prisma.story.update({
          where: { id: storyId },
          data: { 
            cloudflare_id: cloudflareStreamId 
          }
        });
        
        logger.info(`Video uploaded to Cloudflare Stream successfully`);
        logger.info(`Stream UID: ${cloudflareStreamId}`);
        logger.info(`Stream status: ${response.data.result.status.state}`);
        logger.info(`Preview URL: ${response.data.result.preview}`);
        logger.info(`HLS URL: ${response.data.result.playback.hls}`);
      } else {
        logger.error(`Cloudflare Stream upload failed: ${JSON.stringify(response.data.errors)}`);
      }
    } catch (error) {
      logger.error(`Error uploading to Cloudflare Stream: ${error}`);
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Collect all necessary assets for video generation
   */
  private async collectVideoAssets(storyId: string): Promise<VideoAssets> {
    try {
      // Get story with audio URL (no subtitles needed)
      const story = await prisma.story.findUnique({
        where: { id: storyId },
        select: { 
          audio_url: true
        }
      });

      if (!story?.audio_url) {
        throw new Error('Story audio not found');
      }

      // Get audio segments with scene durations
      const audioSegments = await prisma.audioSegment.findMany({
        where: { story_id: storyId, status: 'completed' },
        orderBy: { scene_number: 'asc' },
        select: {
          scene_id: true,
          scene_number: true,
          scene_duration: true
        }
      });

      // Get all images grouped by scene
      const images = await prisma.image.findMany({
        where: { story_id: storyId, status: 'completed' },
        orderBy: [{ scene_id: 'asc' }, { shot_number: 'asc' }],
        select: {
          id: true,
          scene_id: true,
          shot_number: true,
          image_url: true,
          duration: true
        }
      });

      // Get music
      const music = await prisma.music.findFirst({
        where: { story_id: storyId, status: 'completed' },
        select: { audio_url: true }
      });

      if (!music?.audio_url) {
        throw new Error('Story music not found');
      }

      // Group images by scene and convert types properly
      const scenes: SceneData[] = audioSegments.map(segment => ({
        scene_id: segment.scene_id,
        scene_number: segment.scene_number,
        scene_duration: segment.scene_duration ? Number(segment.scene_duration) : 0,
        images: images
          .filter(img => img.scene_id === segment.scene_id)
          .sort((a, b) => a.shot_number - b.shot_number) // Sort by shot_number
          .map(img => {
            const imageData: ImageData = {
              id: String(img.id), // Convert bigint to string
              scene_id: img.scene_id,
              shot_number: img.shot_number,
              image_url: img.image_url || ''
              // localPath is optional, so we don't set it here
            };
            
            // Only add duration if it exists and is not null
            if (img.duration != null) {
              imageData.duration = Number(img.duration);
            }
            
            return imageData;
          })
      }))
      .sort((a, b) => a.scene_number - b.scene_number); // Sort scenes by scene_number

      return {
        scenes,
        finalAudioUrl: story.audio_url,
        musicUrl: music.audio_url
        // No subtitles field
      };

    } catch (error) {
      logger.error(`Error collecting video assets: ${error}`);
      throw error;
    }
  }

  /**
   * Download all assets (images, audio, music) to temp directory
   */
  private async downloadAssets(assets: VideoAssets, tempDir: string): Promise<void> {
    try {
      logger.info('Downloading video assets...');

      // Download final audio
      const audioResponse = await axios.get(assets.finalAudioUrl, { responseType: 'arraybuffer' });
      assets.finalAudioPath = path.join(tempDir, 'final_audio.mp3');
      fs.writeFileSync(assets.finalAudioPath, Buffer.from(audioResponse.data));

      // Download music
      const musicResponse = await axios.get(assets.musicUrl, { responseType: 'arraybuffer' });
      assets.musicPath = path.join(tempDir, 'music.mp3');
      fs.writeFileSync(assets.musicPath, Buffer.from(musicResponse.data));

      // Download all images in correct order
      for (const scene of assets.scenes.sort((a, b) => a.scene_number - b.scene_number)) {
        for (const image of scene.images.sort((a, b) => a.shot_number - b.shot_number)) {
          const imageResponse = await axios.get(image.image_url, { responseType: 'arraybuffer' });
          const fileName = `scene_${scene.scene_number.toString().padStart(2, '0')}_shot_${image.shot_number.toString().padStart(2, '0')}.jpg`;
          image.localPath = path.join(tempDir, fileName);
          fs.writeFileSync(image.localPath, Buffer.from(imageResponse.data));
          logger.info(`Downloaded: ${fileName}`);
        }
      }

      logger.info('All assets downloaded successfully');
    } catch (error) {
      logger.error(`Error downloading assets: ${error}`);
      throw error;
    }
  }

  /**
   * Calculate image timing based on actual audio duration
   */
  private calculateImageTiming(scenes: SceneData[], actualAudioDuration: number): {
    imageTimings: Array<{ imagePath: string; duration: number }>;
    totalDuration: number;
  } {
    const imageTimings: Array<{ imagePath: string; duration: number }> = [];
    
    // Total video duration = intro pad + audio duration + outro fade
    const totalDuration = INTRO_PAD_SEC + actualAudioDuration + OUTRO_FADE_SEC;
    
    // Calculate total scene duration from scenes
    const totalSceneDuration = scenes.reduce((sum, scene) => sum + scene.scene_duration, 0);
    
    let currentTime = 0;

    scenes.forEach((scene, sceneIndex) => {
      const imagesInScene = scene.images.length;
      if (imagesInScene === 0) return;

      // Sort images by shot_number to ensure correct order
      const sortedImages = scene.images.sort((a, b) => a.shot_number - b.shot_number);

      // Base duration per image in this scene
      let baseDuration = scene.scene_duration / imagesInScene;

      sortedImages.forEach((image, imageIndex) => {
        let duration = baseDuration;

        // First image gets the intro padding
        if (sceneIndex === 0 && imageIndex === 0) {
          duration = baseDuration + INTRO_PAD_SEC;
          currentTime = 0; // Reset to ensure we start from 0
        }

        // Last image gets extended for the outro
        if (sceneIndex === scenes.length - 1 && imageIndex === sortedImages.length - 1) {
          // This is the last image, extend it to cover the outro
          const timeUsed = currentTime + baseDuration;
          const timeRemaining = totalDuration - timeUsed;
          if (timeRemaining > 0) {
            duration = baseDuration + timeRemaining;
          } else {
            // Safety check: ensure we at least have the outro time
            duration = baseDuration + OUTRO_FADE_SEC;
          }
        }

        imageTimings.push({
          imagePath: image.localPath!,
          duration: Math.max(0.1, duration) // Ensure minimum duration
        });

        currentTime += duration;
      });
    });

    // Validate total duration
    const calculatedTotal = imageTimings.reduce((sum, t) => sum + t.duration, 0);
    logger.info(`Calculated total from images: ${calculatedTotal.toFixed(2)}s, Expected: ${totalDuration.toFixed(2)}s`);
    
    // If there's a mismatch, adjust the last image
    if (Math.abs(calculatedTotal - totalDuration) > 0.1) {
      const lastTiming = imageTimings[imageTimings.length - 1];
      if (lastTiming) {
        const adjustment = totalDuration - calculatedTotal;
        lastTiming.duration += adjustment;
        logger.info(`Adjusted last image duration by ${adjustment.toFixed(2)}s`);
      }
    }

    logger.info(`Total video duration: ${totalDuration.toFixed(2)}s (${INTRO_PAD_SEC}s intro + ${actualAudioDuration.toFixed(2)}s audio + ${OUTRO_FADE_SEC}s outro)`);
    logger.info(`Image durations: ${imageTimings.map(t => t.duration.toFixed(2)).join(', ')}`);

    return { imageTimings, totalDuration: Math.floor(totalDuration) }; // Return integer duration to avoid FFmpeg issues
  }

  /**
   * Process music: fade-in from 0, fade-out at end
   */
  private async processMusicForVideo(
    musicPath: string,
    targetDuration: number,
    tempDir: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(tempDir, 'processed_music.mp3');
      
      // Get music duration first
      ffmpeg.ffprobe(musicPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        
        const musicDuration = metadata.format.duration || 299;
        let command = ffmpeg(musicPath);

        // If we need to loop the music
        if (targetDuration > musicDuration) {
          const loops = Math.ceil(targetDuration / musicDuration);
          logger.info(`Looping music ${loops} times for duration ${targetDuration}s`);
          command = command.inputOptions([`-stream_loop ${loops - 1}`]);
        }

        const fadeOutStart = Math.max(0, targetDuration - OUTRO_FADE_SEC);

        command
          .audioFilters([
            `atrim=0:${targetDuration}`, // Trim to exact duration
            `afade=t=in:st=0:d=${INTRO_FADE_SEC}`, // Smooth fade-in at the beginning
            `afade=t=out:st=${fadeOutStart}:d=${OUTRO_FADE_SEC}` // Smooth fade-out at the end
          ])
          .outputOptions([
            '-acodec', 'libmp3lame',
            '-b:a', '192k'
          ])
          .on('start', (commandLine) => {
            logger.info(`Processing music: ${INTRO_FADE_SEC}s fade-in, ${OUTRO_FADE_SEC}s fade-out starting at ${fadeOutStart}s`);
            logger.info(`Music command: ${commandLine}`);
          })
          .on('end', () => {
            logger.info('Music processing completed with smooth fades');
            resolve(outputPath);
          })
          .on('error', (err) => {
            logger.error(`Music processing error: ${err.message}`);
            reject(err);
          })
          .save(outputPath);
      });
    });
  }

  /**
   * Create the final video WITHOUT subtitles
   */
  private async createVideo(
    assets: VideoAssets,
    imageTiming: { imageTimings: Array<{ imagePath: string; duration: number }>, totalDuration: number },
    processedMusicPath: string,
    tempDir: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(tempDir, 'final_video.mp4');

      // Create concat file for images with durations
      const concatFile = path.join(tempDir, 'images.txt');
      
      if (imageTiming.imageTimings.length === 0) {
        throw new Error('No images found for video generation');
      }
      
      const lastImage = imageTiming.imageTimings[imageTiming.imageTimings.length - 1]!;
      const concatContent = imageTiming.imageTimings
        .map(timing => `file '${timing.imagePath.replace(/'/g, "'\\''")}'\nduration ${timing.duration.toFixed(3)}`)
        .join('\n') + `\nfile '${lastImage.imagePath.replace(/'/g, "'\\''")}'\n`;
      
      fs.writeFileSync(concatFile, concatContent);
      logger.info(`Created concat file with ${imageTiming.imageTimings.length} images`);

      const totalDuration = Math.floor(imageTiming.totalDuration);

      // Step 1: Create video with images (no subtitles)
      const tempVideoPath = path.join(tempDir, 'temp_video.mp4');
      
      // Build scaling/cropping filters to guarantee strict 16:9 output
      const vfPad = [
        `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`,
        `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
        'setsar=1',
        'setdar=16/9'
      ];

      const vfCover = [
        // Scale up until we cover 16:9, then crop the overflow (no black bars)
        `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase`,
        `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`,
        'setsar=1',
        'setdar=16/9'
      ];

      const videoFilters = VIDEO_FIT_MODE === 'pad' ? vfPad : vfCover;

      let videoCommand = ffmpeg()
        .input(concatFile)
        .inputOptions(['-f concat', '-safe 0'])
        .videoFilters(videoFilters);

      // Create video without audio first
      videoCommand
        .outputOptions([
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-aspect', '16:9',
          '-r', '30',
          '-preset', 'fast',
          '-crf', '23',
          '-an', // No audio
          '-t', totalDuration.toString()
        ])
        .on('start', (commandLine) => {
          logger.info(`Step 1: Creating video with images for ${totalDuration}s`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            logger.info(`Video creation progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          logger.info('Step 1 completed - video created');
          
          // Step 2: Add audio to the video
          this.addAudioToVideo(tempVideoPath, processedMusicPath, assets.finalAudioPath!, outputPath, totalDuration)
            .then(() => {
              // Clean up temp video
              try {
                fs.unlinkSync(tempVideoPath);
              } catch (err) {
                logger.warn(`Could not delete temp video: ${err}`);
              }
              resolve(outputPath);
            })
            .catch(reject);
        })
        .on('error', (err) => {
          logger.error(`Video creation error: ${err.message}`);
          reject(err);
        })
        .save(tempVideoPath);
    });
  }

  /**
   * Add mixed audio to the video with proper fade timings
   */
  private async addAudioToVideo(
    videoPath: string,
    musicPath: string,
    voicePath: string,
    outputPath: string,
    duration: number
  ): Promise<void> {
    const tempDir = path.dirname(videoPath);
    const mixedAudioPath = path.join(tempDir, 'mixed_audio.mp3');
    
    try {
      // Step 2a: Create the mixed audio first
      await this.createMixedAudio(musicPath, voicePath, mixedAudioPath, duration);
      
      // Step 2b: Combine video with mixed audio
      await this.combineVideoWithAudio(videoPath, mixedAudioPath, outputPath, duration);
      
      // Clean up mixed audio
      try {
        fs.unlinkSync(mixedAudioPath);
      } catch (err) {
        logger.warn(`Could not delete mixed audio: ${err}`);
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create mixed audio track with voice delay and proper volumes
   */
  private async createMixedAudio(
    musicPath: string,
    voicePath: string,
    outputPath: string,
    duration: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const voiceDelayMs = INTRO_PAD_SEC * 1000;
      
      logger.info(`Step 2a: Creating mixed audio track`);
      
      const command = ffmpeg()
        .input(musicPath)    // [0:a] music (already has fades)
        .input(voicePath);   // [1:a] voice
      
      // Create filter for audio mixing
      const audioFilter = [
        // Delay voice by INTRO_PAD_SEC and add fade-in
        `[1:a]adelay=${voiceDelayMs}|${voiceDelayMs},afade=in:st=0:d=${INTRO_FADE_SEC},volume=1.0[voice]`,
        // Adjust music volume (already has fades from preprocessing)
        '[0:a]volume=0.3[music]',
        // Mix the two audio streams
        '[music][voice]amix=inputs=2:duration=longest:dropout_transition=0[mixed]'
      ].join(';');
      
      command
        .complexFilter(audioFilter)
        .outputOptions([
          '-map', '[mixed]',
          '-acodec', 'libmp3lame',
          '-b:a', '192k',
          '-t', duration.toString()
        ])
        .on('start', (cmd) => {
          logger.info(`Mixing audio: music at 30% volume, voice delayed by ${INTRO_PAD_SEC}s with ${INTRO_FADE_SEC}s fade-in`);
          logger.info(`Audio mix command: ${cmd}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            logger.info(`Audio mixing progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          logger.info('Audio mixing completed');
          resolve();
        })
        .on('error', (err) => {
          logger.error(`Audio mixing error: ${err.message}`);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Combine video with mixed audio and add video fade-out
   */
  private async combineVideoWithAudio(
    videoPath: string,
    audioPath: string,
    outputPath: string,
    duration: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const fadeOutStart = Math.floor(duration - OUTRO_FADE_SEC);
      
      logger.info(`Step 2b: Combining video with mixed audio`);
      logger.info(`Video fade-out will start at ${fadeOutStart}s for ${OUTRO_FADE_SEC}s`);
      
      const command = ffmpeg()
        .input(videoPath)    // [0:v] video
        .input(audioPath);   // [0:a] mixed audio
      
      // Simple video fade-out filter
      const videoFilter = `fade=out:st=${fadeOutStart}:d=${OUTRO_FADE_SEC}`;
      
      command
        .videoFilters(videoFilter)
        .outputOptions([
          '-c:v', 'libx264',
          '-c:a', 'copy',  // Just copy the audio since it's already processed
          '-preset', 'fast',
          '-movflags', '+faststart',
          '-t', duration.toString()
        ])
        .on('start', (cmd) => {
          logger.info(`Adding mixed audio to video with fade-out`);
          logger.info(`Combine command: ${cmd}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            logger.info(`Video combination progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          logger.info('Step 2 completed - video and audio combined with fade-out');
          resolve();
        })
        .on('error', (err) => {
          logger.error(`Video combination error: ${err.message}`);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Upload final video to DigitalOcean Spaces
   */
  private async uploadVideo(videoPath: string, storyId: string): Promise<string> {
    try {
      const videoBuffer = fs.readFileSync(videoPath);
      const timestamp = Date.now();
      const hash = crypto.createHash('md5').update(storyId + 'video').digest('hex').substring(0, 8);
      const fileName = `videos/${storyId}/final_${timestamp}_${hash}.mp4`;

      const uploadCommand = new PutObjectCommand({
        Bucket: process.env.DO_SPACES_BUCKET!,
        Key: fileName,
        Body: videoBuffer,
        ContentType: 'video/mp4',
        ACL: 'public-read',
      });

      await this.s3Client.send(uploadCommand);

      const baseUrl =
        process.env.DO_SPACES_CDN_URL ||
        `https://${process.env.DO_SPACES_BUCKET}.${process.env.DO_SPACES_REGION}.digitaloceanspaces.com`;
      
      const publicUrl = `${baseUrl}/${fileName}`;
      logger.info(`Video uploaded successfully: ${publicUrl}`);
      
      return publicUrl;
    } catch (error) {
      logger.error(`Error uploading video: ${error}`);
      throw error;
    }
  }

  /**
   * Cleanup temporary directory
   */
  private async cleanupTempDirectory(tempDir: string): Promise<void> {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      logger.info(`Cleaned up video temp directory: ${tempDir}`);
    } catch (error) {
      logger.error(`Error cleaning up video temp directory: ${tempDir}`);
    }
  }
}