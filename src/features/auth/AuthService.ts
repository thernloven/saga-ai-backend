import prisma from "../../lib/prisma.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { otpCache } from "../../utils/otpCache.js";
import { sendMail } from "../../utils/mailer.js";
import logger from "../../utils/logger.js";

export class AuthService {
  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private async sendOtpEmail(email: string, otp: string): Promise<void> {
    const subject = 'Verify Your Email';
    const text = `Your verification code is: ${otp}. This code will expire in 5 minutes.`;
    
    await sendMail(email, subject, text);
    logger.info(`Verification OTP sent to ${email}`);
  }

  async register(email: string, password: string) {
    try {
      const existingUser = await prisma.user.findUnique({
        where: { email }
      });

      if (existingUser) {
        throw new Error("User already exists");
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          isVerified: false
        }
      });

      const otp = this.generateOtp();
      const otpKey = `verify_${email}`;
      
      otpCache.set(otpKey, otp, 300);
      await this.sendOtpEmail(email, otp);

      return {
        message: "User registered successfully. Please check your email for verification code.",
        userId: user.id
      };
    } catch (error) {
      logger.error(`Registration error: ${error}`);
      throw error;
    }
  }

  async verifyOtp(email: string, otp: string) {
    try {
      const otpKey = `verify_${email}`;
      const cachedOtp = otpCache.get(otpKey);

      if (!cachedOtp || cachedOtp !== otp) {
        throw new Error("Invalid or expired OTP");
      }

      otpCache.del(otpKey);

      const user = await prisma.user.update({
        where: { email },
        data: { isVerified: true }
      });

      const token = jwt.sign(
        { id: user.id, email: user.email },
        process.env.JWT_SECRET!,
        { expiresIn: '24h' }
      );

      return {
        message: "Email verified successfully",
        token,
        user: {
          id: user.id,
          email: user.email,
          isVerified: user.isVerified
        }
      };
    } catch (error) {
      logger.error(`OTP verification error: ${error}`);
      throw error;
    }
  }

  async login(email: string, password: string) {
    try {
      const user = await prisma.user.findUnique({
        where: { email }
      });

      if (!user) {
        throw new Error("Invalid credentials");
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        throw new Error("Invalid credentials");
      }

      if (!user.isVerified) {
        throw new Error("Please verify your email first");
      }

      const token = jwt.sign(
        { id: user.id, email: user.email },
        process.env.JWT_SECRET!,
        { expiresIn: '24h' }
      );

      return {
        message: "Login successful",
        token,
        user: {
          id: user.id,
          email: user.email,
          isVerified: user.isVerified
        }
      };
    } catch (error) {
      logger.error(`Login error: ${error}`);
      throw error;
    }
  }

  async resendVerificationOtp(email: string) {
    try {
      const user = await prisma.user.findUnique({
        where: { email }
      });

      if (!user) {
        throw new Error("User not found");
      }

      if (user.isVerified) {
        throw new Error("Email already verified");
      }

      const otp = this.generateOtp();
      const otpKey = `verify_${email}`;
      
      otpCache.set(otpKey, otp, 300);
      await this.sendOtpEmail(email, otp);

      return {
        message: "Verification OTP resent successfully"
      };
    } catch (error) {
      logger.error(`Resend verification OTP error: ${error}`);
      throw error;
    }
  }

  async getProfile(userId: string) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, isVerified: true, createdAt: true }
      });

      if (!user) {
        throw new Error("User not found");
      }

      return user;
    } catch (error) {
      logger.error(`Get profile error: ${error}`);
      throw error;
    }
  }

async logout(token: string) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    
    // Add token to blacklist with its expiration time
    await prisma.tokenBlacklist.create({
      data: {
        token,
        expiresAt: new Date(decoded.exp * 1000) // JWT exp is in seconds, convert to milliseconds
      }
    });
    
    return {
      success: true,
      message: "Logged out successfully"
    };
  } catch (error) {
    logger.error(`Logout error: ${error}`);
    return {
      success: false,
      message: "Invalid token"
    };
  }
}
}