// Add these to your existing types/index.ts file

export interface SceneData {
  scene_id: string;
  scene_number: number;
  scene_duration: number;
  images: ImageData[];
}

export interface ImageData {
  id: string;
  scene_id: string;
  shot_number: number;
  image_url: string;
  duration?: number;      // Add this for shot-specific durations
  localPath?: string;
}

export interface VideoAssets {
  scenes: SceneData[];
  finalAudioUrl: string;
  musicUrl: string;
  subtitles?: any;        // Add this for subtitle data
  finalAudioPath?: string;
  musicPath?: string;
}