export interface StoryRequest {
  story: string;
  style: 'conversational' | 'narrative' | 'interview' | 'documentary' | 'educational';
  speakers: 'single' | 'dual';
  voices: string[];
  tone: string;
  duration: string;
  imageStyle: 'realistic' | 'comic' | 'cartoon' | 'drawing' | 'watercolor' | 'noir' | 'sketch';
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created_at: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  background: boolean;
  model: string;
  output?: Array<{
    text?: string;
    [key: string]: any;
  }>;
  error?: string;
  [key: string]: any;
}

export interface Scene {
  id: string;
  startTime: number;
  duration: number;
  wordCount: number;
  inputs: Array<{
    text: string;
    voice_id: string;
    imagePrompt: string; // Now each input has its own image prompt
  }>;
  imagePrompt?: string; // Optional, kept for backward compatibility
}

export interface EnhancedScript {
  title: string;
  totalDuration: number;
  estimatedWordsPerMinute: number;
  scenes: Scene[];
  metadata: {
    totalScenes: number;
    averageSceneDuration: number;
    totalWords: number;
    estimationMethod: string;
    speechStyle: string;
    imageStyle: string;
  };
}

export interface WebhookEvent {
  type: 'response.completed' | 'response.failed' | string;
  data: {
    id: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface OpenAIResponseData {
  id: string;
  object: string;
  created_at: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  background: boolean;
  model: string;
  output?: Array<{
    id: string;
    type: 'message' | 'reasoning' | 'image_generation_call';
    status?: string;
    content?: Array<{
      type: 'output_text' | 'image';
      text?: string;
      source?: {
        data: string;
        media_type: string;
      };
      [key: string]: any;
    }>;
    role?: string;
    // Properties specific to image_generation_call
    background?: string;
    output_format?: string;
    quality?: string;
    result?: string; // The base64 image data
    [key: string]: any;
  }>;
  error?: string;
  [key: string]: any;
}

// Audio-specific interfaces
export interface AudioInput {
  text: string;
  voice_id: string;
}

export interface AudioChunk {
  inputs: AudioInput[];
  chunkNumber: number;
  totalCharacters: number;
}

export interface MusicGenerationRequest {
  prompt: string;
  musicLengthMs: number;
}

export interface ElevenLabsResponse {
  music_id: string;
  status: string;
  created_at: string;
}

export interface ElevenLabsMusicStatus {
  music_id: string;
  status: 'processing' | 'completed' | 'failed';
  audio_url?: string;
  created_at: string;
  updated_at: string;
}

export interface MusicRecord {
  id: string;
  story_id: string;
  music_id: string;
  prompt: string;
  duration_ms: number;
  status: string;
  audio_url?: string;
  created_at: Date;
  updated_at: Date;
}