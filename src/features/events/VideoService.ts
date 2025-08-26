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

      // 3. Calculate timing for each image
      const imageTiming = this.calculateImageTiming(assets.scenes);

      // 4. Process music (loop, trim, fade)
      const processedMusicPath = await this.processMusicForVideo(
        assets.musicPath!,
        imageTiming.totalDuration,
        tempDir
      );

      // 5. Generate video using FFmpeg (no subtitles)
      const videoPath = await this.createVideo(
        assets,
        imageTiming,
        processedMusicPath,
        tempDir
      );

      // 6. Upload final video to Spaces
      const videoUrl = await this.uploadVideo(videoPath, storyId);

      // 7. Update story with video URL and status
      await prisma.story.update({
        where: { id: storyId },
        data: { 
          video_url: videoUrl,
          status: 'do_completed'  // Changed from 'completed' to 'do_completed'
        }
      });

      // 8. Upload to Cloudflare Stream
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
   * Calculate image timing - everything starts at 0
   */
  private calculateImageTiming(scenes: SceneData[]): {
    imageTimings: Array<{ imagePath: string; duration: number }>;
    totalDuration: number;
  } {
    const imageTimings: Array<{ imagePath: string; duration: number }> = [];
    let totalDuration = 0;

    scenes.forEach((scene, sceneIndex) => {
      const imagesInScene = scene.images.length;
      if (imagesInScene === 0) return;

      // Sort images by shot_number to ensure correct order
      const sortedImages = scene.images.sort((a, b) => a.shot_number - b.shot_number);

      // Base duration per image in this scene
      const baseDuration = scene.scene_duration / imagesInScene;

      sortedImages.forEach((image, imageIndex) => {
        let duration = baseDuration;

        // NO INTRO PADDING - everything starts at 0

        // Last image of last scene gets extra time for outro fade
        if (sceneIndex === scenes.length - 1 && imageIndex === sortedImages.length - 1) {
          duration += OUTRO_FADE_SEC; // Extended for outro fade-out
        }

        imageTimings.push({
          imagePath: image.localPath!,
          duration: duration
        });
      });

      // Add scene duration to total
      totalDuration += scene.scene_duration;
    });

    // Only add outro time to total (no intro time)
    totalDuration += OUTRO_FADE_SEC;

    return { imageTimings, totalDuration };
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
      const musicDuration = 299; // 4:59 in seconds

      let command = ffmpeg(musicPath);

      // If we need to loop the music
      if (targetDuration > musicDuration) {
        const loops = Math.ceil(targetDuration / musicDuration);
        logger.info(`Looping music ${loops} times for duration ${targetDuration}s`);
        command = command.inputOptions([`-stream_loop ${loops - 1}`]);
      }

      command
        .audioFilters([
          `atrim=0:${targetDuration}`, // Trim to exact duration
          'volume=1.5', // LOUDER music - 150% of original volume
          `afade=in:st=0:d=${INTRO_FADE_SEC}`, // fade-in from start
          `afade=out:st=${targetDuration - OUTRO_FADE_SEC}:d=${OUTRO_FADE_SEC}` // fade-out at end
        ])
        .on('start', (commandLine) => {
          logger.info(`Processing music: ${INTRO_FADE_SEC}s fade-in from start, 150% volume, ${OUTRO_FADE_SEC}s fade-out`);
        })
        .on('end', () => {
          logger.info('Music processing completed with louder volume');
          resolve(outputPath);
        })
        .on('error', (err) => {
          logger.error(`Music processing error: ${err.message}`);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Create the final video WITHOUT subtitles
   */
  private async createVideo(
    assets: VideoAssets,
    imageTiming: { imageTimings: Array<{ imagePath: string; duration: number }> },
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
        .map(timing => `file '${timing.imagePath.replace(/'/g, "'\\''")}'\nduration ${timing.duration}`)
        .join('\n') + `\nfile '${lastImage.imagePath.replace(/'/g, "'\\''")}'\n`;
      
      fs.writeFileSync(concatFile, concatContent);

      const totalDuration = imageTiming.imageTimings.reduce((sum, timing) => sum + timing.duration, 0);

      // Step 1: Create video with images (no subtitles)
      const tempVideoPath = path.join(tempDir, 'temp_video.mp4');
      
      let videoCommand = ffmpeg()
        .input(concatFile)
        .inputOptions(['-f concat', '-safe 0'])
        .videoFilters([
          'scale=1920:1080:force_original_aspect_ratio=decrease',
          'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black'
        ]);

      // Create video without audio first
      videoCommand
        .outputOptions([
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-r', '30',
          '-preset', 'fast',
          '-crf', '23',
          '-an', // No audio
          '-t', totalDuration.toString()
        ])
        .on('start', (commandLine) => {
          logger.info(`Step 1: Creating video with images`);
          logger.info(`Video command: ${commandLine}`);
        })
        .on('end', () => {
          logger.info('Step 1 completed - video created');
          
          // Step 2: Add audio to the video
          this.addAudioToVideo(tempVideoPath, processedMusicPath, assets.finalAudioPath!, outputPath, totalDuration)
            .then(() => {
              // Clean up temp video
              fs.unlinkSync(tempVideoPath);
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
   * Add mixed audio to the video - everything starts at 0 with fade-ins
   */
  private async addAudioToVideo(
    videoPath: string,
    musicPath: string,
    voicePath: string,
    outputPath: string,
    duration: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const useSimpleMix = process.env.VIDEO_SIMPLE_MIX === '1';

      let command = ffmpeg()
        .input(videoPath)      // [0:v] video
        .input(musicPath)      // [1:a] music (already has fade-in/out)
        .input(voicePath);     // [2:a] voice

      if (useSimpleMix) {
        // Simple mixing approach
        command = command
          .complexFilter([
            // Add fade-out to video in last OUTRO_FADE_SEC seconds
            `[0:v]fade=out:st=${duration - OUTRO_FADE_SEC}:d=${OUTRO_FADE_SEC}[video_faded]`,
            // Voice starts at 0 with fade-in (NO DELAY)
            `[2:a]afade=in:st=0:d=${INTRO_FADE_SEC}[voice]`,
            // Music volume (already has fade-in/out from processMusicForVideo)
            '[1:a]volume=0.8[music]',
            '[music][voice]amix=inputs=2:duration=longest[audio]'
          ])
          .outputOptions([
            '-map', '[video_faded]',
            '-map', '[audio]',
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-t', duration.toString(),
            '-movflags', '+faststart'
          ]);
      } else {
        // Advanced mixing with sidechain compression
        command = command
          .complexFilter([
            // Add fade-out to video in last OUTRO_FADE_SEC seconds
            `[0:v]fade=out:st=${duration - OUTRO_FADE_SEC}:d=${OUTRO_FADE_SEC}[video_faded]`,
            // Voice starts at 0 with fade-in (NO DELAY)
            `[2:a]afade=in:st=0:d=${INTRO_FADE_SEC}[voice_faded]`,
            '[voice_faded]asplit=2[voice_trigger][voice_final]',
            // Apply sidechain compression to music using voice trigger
            '[1:a][voice_trigger]sidechaincompress=threshold=0.05:ratio=4:attack=50:release=250[music_ducked]',
            // Mix ducked music with final voice
            '[music_ducked][voice_final]amix=inputs=2:duration=longest:weights=0.8 1.0[audio]'
          ])
          .outputOptions([
            '-map', '[video_faded]',
            '-map', '[audio]',
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-t', duration.toString(),
            '-movflags', '+faststart'
          ]);
      }

      command
        .on('start', (commandLine) => {
          logger.info(`Step 2: Adding mixed audio with video fade-out`);
          logger.info(
            useSimpleMix
              ? `- Simple mix: music 0.8, voice starts at 0 with ${INTRO_FADE_SEC}s fade-in`
              : `- Ducked mix: music 0.8, voice starts at 0 with ${INTRO_FADE_SEC}s fade-in`
          );
          logger.info(`- Video fade-out: last ${OUTRO_FADE_SEC} seconds`);
          logger.info(`Audio command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          logger.info(`Audio mixing progress: ${Math.round(progress.percent || 0)}%`);
        })
        .on('end', () => {
          logger.info('Step 2 completed - audio and video fade-out added');
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