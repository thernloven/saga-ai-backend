import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { AuthController } from "../features/auth/AuthController.js";
import { StoryController } from "../features/story/controllers/StoryController.js";
import { ResponseController } from "../features/response/controllers/ResponseController.js";
import { SubtitleController } from '../features/story/controllers/SubtitleController.js';


const router = Router();
const authController = new AuthController();
const storyController = new StoryController();
const responseController = new ResponseController();
const subtitleController = new SubtitleController();

router.post('/auth/validate', authenticate, (req, res) => {
  // If we reach here, the token is valid (authenticate middleware passed)
  res.status(200).json({
    success: true,
    message: 'Token is valid',
    user: {
      id: req.user!.id,
      email: req.user!.email,
    }
  });
});

// Logout route
router.post("/auth/logout", authController.logout.bind(authController));

// Public auth routes
router.post("/auth/register", authController.register.bind(authController));
router.post("/auth/verify-otp", authController.verifyOtp.bind(authController));
router.post("/auth/login", authController.login.bind(authController));
router.post("/auth/resend-otp", authController.resendVerificationOtp.bind(authController));

// Protected auth routes
router.get("/auth/profile", authenticate, authController.getProfile.bind(authController));

//Story generation
router.post("/story/generate", authenticate, storyController.generateStory.bind(storyController));

//Response
router.post("/webhook/openai", responseController.handleWebhook.bind(responseController));
router.post("/webhook/cloudflare", responseController.handleCloudflareWebhook.bind(responseController));

// Add authentication middleware
router.post('/story/captions/:storyId', authenticate, subtitleController.generateCaptions.bind(subtitleController));

export default router;
