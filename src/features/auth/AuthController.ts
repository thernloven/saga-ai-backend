import type { Request, Response } from "express";
import { AuthService } from "./AuthService.js";
import logger from "../../utils/logger.js";

const authService = new AuthService();

export class AuthController {
  async register(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({ error: "Email and password are required" });
        return;
      }

      const result = await authService.register(email, password);
      res.status(201).json(result);
    } catch (error) {
      logger.error(`Register controller error: ${error}`);
      res.status(400).json({ error: (error as Error).message });
    }
  }

  async verifyOtp(req: Request, res: Response): Promise<void> {
    try {
      const { email, otp } = req.body;

      if (!email || !otp) {
        res.status(400).json({ error: "Email and OTP are required" });
        return;
      }

      const result = await authService.verifyOtp(email, otp);
      res.status(200).json(result);
    } catch (error) {
      logger.error(`Verify OTP controller error: ${error}`);
      res.status(400).json({ error: (error as Error).message });
    }
  }

  async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({ error: "Email and password are required" });
        return;
      }

      const result = await authService.login(email, password);
      res.status(200).json(result);
    } catch (error) {
      logger.error(`Login controller error: ${error}`);
      res.status(400).json({ error: (error as Error).message });
    }
  }

  async resendVerificationOtp(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      if (!email) {
        res.status(400).json({ error: "Email is required" });
        return;
      }

      const result = await authService.resendVerificationOtp(email);
      res.status(200).json(result);
    } catch (error) {
      logger.error(`Resend verification OTP controller error: ${error}`);
      res.status(400).json({ error: (error as Error).message });
    }
  }

  async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const userId = (req as any).user?.id;

      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const user = await authService.getProfile(userId);
      res.status(200).json(user);
    } catch (error) {
      logger.error(`Get profile controller error: ${error}`);
      res.status(400).json({ error: (error as Error).message });
    }
  }
}