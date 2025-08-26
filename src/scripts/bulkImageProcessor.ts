import prisma from "../lib/prisma.js";
import { ResponseService } from "../features/response/services/ResponseService.js";
import logger from "../utils/logger.js";

const responseService = new ResponseService();

// 🎯 CHANGE THIS STORY ID TO PROCESS DIFFERENT STORIES
const STORY_ID = "cmer594ld0001qgxrdix954c3";

async function processImagesForStory() {
  try {
    logger.info(`Processing all images for story: ${STORY_ID}`);
    
    // Get all images for this story that have response IDs but no image URLs
    const images = await prisma.image.findMany({
      where: {
        story_id: STORY_ID,
        openai_response_id: {
          not: null
        },
        // Optionally only process ones that haven't been completed yet
        image_url: null
      },
      select: {
        id: true,
        scene_id: true,
        shot_number: true,
        openai_response_id: true,
        status: true
      },
      orderBy: [
        { scene_id: 'asc' },
        { shot_number: 'asc' }
      ]
    });
    
    if (images.length === 0) {
      logger.info(`No pending images found for story: ${STORY_ID}`);
      return;
    }
    
    logger.info(`Found ${images.length} images to process`);
    
    let processed = 0;
    let failed = 0;
    
    for (const image of images) {
      try {
        logger.info(`Processing image ${processed + 1}/${images.length}: Scene ${image.scene_id}, Shot ${image.shot_number}`);
        
        // Create mock webhook event
        const mockWebhookEvent = {
          type: "response.completed" as const,
          data: {
            id: image.openai_response_id!,
            status: "completed"
          }
        };
        
        await responseService.handleWebhook(mockWebhookEvent);
        processed++;
        
        logger.info(`✅ Processed: ${image.scene_id} shot ${image.shot_number}`);
        
        // Small delay to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        failed++;
        logger.error(`❌ Failed to process ${image.scene_id} shot ${image.shot_number}: ${error}`);
      }
    }
    
    logger.info(`\n📊 Processing complete for story ${STORY_ID}:`);
    logger.info(`   ✅ Processed: ${processed}`);
    logger.info(`   ❌ Failed: ${failed}`);
    logger.info(`   📝 Total: ${images.length}`);
    
  } catch (error) {
    logger.error(`Error processing images for story: ${error}`);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
processImagesForStory()
  .then(() => {
    logger.info("Image processing finished");
    process.exit(0);
  })
  .catch((error) => {
    logger.error(`Image processing failed: ${error}`);
    process.exit(1);
  });