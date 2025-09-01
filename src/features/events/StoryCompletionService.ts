import prisma from "../../lib/prisma.js";
import logger from "../../utils/logger.js";

export class StoryCompletionService {
  private static completionChecks = new Set<string>(); // Prevent duplicate checks
  
  // Accept story as complete if at least 90% of images are successful
  private static readonly MIN_IMAGE_SUCCESS_RATE = 0.90;

  // Image pipeline statuses
  private static readonly NON_TERMINAL_STATUSES = ['queued', 'pending', 'generating'];
  private static readonly TERMINAL_FAILED_STATUSES = ['failed', 'terminal_failed']; // adjust if you only use 'failed'

  /**
   * Check if all components of a story are completed and update status accordingly
   * Should be called whenever audio, images, or music completes
   */
  async checkStoryCompletion(storyId: string): Promise<void> {
    // Prevent multiple simultaneous checks for the same story
    if (StoryCompletionService.completionChecks.has(storyId)) {
      logger.info(`Story completion check already in progress for: ${storyId}`);
      return;
    }

    StoryCompletionService.completionChecks.add(storyId);

    try {
      logger.info(`Checking story completion for: ${storyId}`);

      // Get story data
      const story = await prisma.story.findUnique({
        where: { id: storyId }
      });

      if (!story) {
        logger.warn(`Story not found: ${storyId}`);
        return;
      }

      // Skip if already completed
      if (story.status === 'completed') {
        logger.info(`Story already completed: ${storyId}`);
        return;
      }

      // Check 1: Audio completed?
      const hasAudio = await this.checkAudioCompletion(storyId);
      if (!hasAudio) {
        logger.info(`Story ${storyId}: Audio not ready`);
        return;
      }

      // Check 2: Images completion (must all be attempted, then pass success threshold)
      const imagesResult = await this.checkImagesCompletion(storyId);
      if (!imagesResult.allAttempted) {
        logger.info(`Story ${storyId}: Images not ready — still in progress: ${imagesResult.nonTerminal} (completed ${imagesResult.completed}/${imagesResult.total})`);
        return;
      }
      if (!imagesResult.acceptable) {
        logger.info(`Story ${storyId}: Images below threshold (${(imagesResult.successRate * 100).toFixed(1)}% < ${(StoryCompletionService.MIN_IMAGE_SUCCESS_RATE * 100).toFixed(0)}%)`);
        return;
      }

      // Check 3: Music completed?
      const musicComplete = await this.checkMusicCompletion(storyId);
      if (!musicComplete) {
        logger.info(`Story ${storyId}: Music not ready`);
        return;
      }

      // All components are ready - mark story as completed!
      await this.markStoryCompleted(storyId);

      logger.info(`🎉 Story fully completed: ${storyId} (${imagesResult.completed}/${imagesResult.total} images, ${imagesResult.successRate.toFixed(1)}% success rate)`);

      // Optional: Trigger next phase (video generation, notifications, etc.)
      await this.triggerNextPhase(storyId);

    } catch (error) {
      logger.error(`Error checking story completion for ${storyId}: ${error}`);
      throw error;
    } finally {
      StoryCompletionService.completionChecks.delete(storyId);
    }
  }

  /**
   * Check if audio is completed for the story
   */
  private async checkAudioCompletion(storyId: string): Promise<boolean> {
    try {
      const story = await prisma.story.findUnique({
        where: { id: storyId },
        select: { audio_url: true, status: true }
      });

      // Audio is ready if we have an audio_url and status is audio_completed
      return !!(story?.audio_url && story?.status === 'audio_completed');
    } catch (error) {
      logger.error(`Error checking audio completion: ${error}`);
      return false;
    }
  }

  /**
   * Check if images are sufficiently completed for the story.
   * New rule: require ALL images to reach a terminal state (completed or failed) BEFORE
   * applying the success-rate threshold (MIN_IMAGE_SUCCESS_RATE).
   */
  private async checkImagesCompletion(storyId: string): Promise<{
    acceptable: boolean;      // ready to proceed (allAttempted && successRate >= min)
    total: number;            // total images in DB for this story
    completed: number;        // status === 'completed'
    failed: number;           // status in TERMINAL_FAILED_STATUSES
    missing: number;          // images not completed (legacy metric kept for compatibility)
    nonTerminal: number;      // status in NON_TERMINAL_STATUSES
    allAttempted: boolean;    // nonTerminal === 0
    successRate: number;      // completed / total
  }> {
    try {
      const [total, completed, failed, nonTerminal] = await Promise.all([
        prisma.image.count({ where: { story_id: storyId } }),
        prisma.image.count({ where: { story_id: storyId, status: 'completed' } }),
        prisma.image.count({ where: { story_id: storyId, status: { in: StoryCompletionService.TERMINAL_FAILED_STATUSES } } }),
        prisma.image.count({ where: { story_id: storyId, status: { in: StoryCompletionService.NON_TERMINAL_STATUSES } } }),
      ]);

      if (total === 0) {
        return {
          acceptable: false,
          total: 0,
          completed: 0,
          failed: 0,
          missing: 0,
          nonTerminal: 0,
          allAttempted: false,
          successRate: 0
        };
      }

      const successRate = completed / total;
      const allAttempted = nonTerminal === 0; // nothing still in progress
      const acceptable = allAttempted && successRate >= StoryCompletionService.MIN_IMAGE_SUCCESS_RATE;

      const missing = total - completed; // legacy metric: everything not completed (includes failed + in-progress)

      logger.info(
        `Story ${storyId}: images — total=${total}, completed=${completed}, failed=${failed}, inProgress=${nonTerminal}, ` +
        `successRate=${(successRate * 100).toFixed(1)}%, allAttempted=${allAttempted}, acceptable=${acceptable}`
      );

      return {
        acceptable,
        total,
        completed,
        failed,
        missing,
        nonTerminal,
        allAttempted,
        successRate
      };
    } catch (error) {
      logger.error(`Error checking images completion: ${error}`);
      return {
        acceptable: false,
        total: 0,
        completed: 0,
        failed: 0,
        missing: 0,
        nonTerminal: 0,
        allAttempted: false,
        successRate: 0
      };
    }
  }

  /**
   * Check if music is completed for the story
   */
  private async checkMusicCompletion(storyId: string): Promise<boolean> {
    try {
      const music = await prisma.music.findFirst({
        where: { story_id: storyId },
        select: { status: true, audio_url: true }
      });

      // Music is ready if it exists, has completed status, and has an audio URL
      return !!(music?.status === 'completed' && music?.audio_url);
    } catch (error) {
      logger.error(`Error checking music completion: ${error}`);
      return false;
    }
  }

  /**
   * Mark the story as completed
   */
  private async markStoryCompleted(storyId: string): Promise<void> {
    try {
      await prisma.story.update({
        where: { id: storyId },
        data: { 
          status: 'audio_completed'
        }
      });

      logger.info(`✅ Story marked as completed: ${storyId}`);
    } catch (error) {
      logger.error(`Error marking story as completed: ${error}`);
      throw error;
    }
  }

  /**
   * Trigger next phase of processing (video generation, notifications, etc.)
   */
  private async triggerNextPhase(storyId: string): Promise<void> {
    try {
      logger.info(`Triggering video generation for story: ${storyId}`);
      
      // Import and trigger video generation
      const { VideoService } = await import("./VideoService.js");
      const videoService = new VideoService();
      
      // Fire-and-forget video generation
      videoService
        .generateVideo(storyId)
        .then((videoUrl) => {
          logger.info(`🎬 Video generation completed for story ${storyId}: ${videoUrl}`);
        })
        .catch((err) => {
          logger.error(`Video generation failed for story ${storyId}: ${err}`);
        });
      
    } catch (error) {
      logger.error(`Error triggering next phase for ${storyId}: ${error}`);
      // Don't throw here - story completion should not fail if next phase fails
    }
  }

  /**
   * Get completion status summary for a story
   */
  async getCompletionStatus(storyId: string): Promise<{
    audio: boolean;
    images: { acceptable: boolean; completed: number; total: number; missing: number; successRate: number };
    music: boolean;
    overall: boolean;
  }> {
    const audio = await this.checkAudioCompletion(storyId);
    const images = await this.checkImagesCompletion(storyId);
    const music = await this.checkMusicCompletion(storyId);
    const overall = audio && images.acceptable && music;

    return { 
      audio, 
      images: {
        acceptable: images.acceptable,
        completed: images.completed,
        total: images.total,
        missing: images.missing,
        successRate: images.successRate,
        // expose new diagnostics
        // @ts-ignore — widening return for richer UI/monitoring
        nonTerminal: (images as any).nonTerminal,
        // @ts-ignore
        allAttempted: (images as any).allAttempted,
      }, 
      music, 
      overall 
    };
  }
}