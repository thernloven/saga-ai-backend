// src/features/websockets/types/index.ts
export interface StoryCompletedData {
  title: string;
  video_url: string | null;
  image_url: string | null;
  created_at: Date;
  duration: string;
}

export interface WebSocketMessage {
  type: 'connected' | 'status' | 'completed' | 'error';
  storyId?: string;
  status?: string;
  message?: string;
  data?: StoryCompletedData;
}