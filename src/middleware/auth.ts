import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma.js"; // Adjust path as needed

export interface JwtPayload { id: string; email: string; }

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const auth = req.headers.authorization?.split(" ");
  if (auth?.[0] !== "Bearer" || !auth[1])
    return res.status(401).json({ error: "No token" });
  
  const token = auth[1];
  
  try {
    // First verify the token is valid
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    
    // Then check if it's blacklisted
    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ error: "Token has been revoked" });
    }
    
    (req as any).user = payload;
    next();
  } catch {
    return res.status(403).json({ error: "Invalid token" });
  }
}

async function isTokenBlacklisted(token: string): Promise<boolean> {
  const blacklistedToken = await prisma.tokenBlacklist.findUnique({
    where: { token }
  });
  
  return !!blacklistedToken;
}