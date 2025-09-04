import prisma from "../../../lib/prisma.js";
import axios from "axios";
import logger from "../../../utils/logger.js";
import type { StoryRequest, OpenAIResponse } from "../types/index.js";

export class StoryService {

  private buildMusicPrompt(style: string, tone: string): string {
    const basePrompt = `${tone} ${style} background instrumental for podcast`;
    
    // Add specific descriptors based on style and tone
    const styleDescriptors = {
      documentary: "cinematic, atmospheric",
      interview: "subtle, professional", 
      narrative: "storytelling, engaging",
      educational: "calm, focused"
    };

    const toneDescriptors = {
      mysterious: "ambient, suspenseful, dark undertones",
      informative: "clean, unobtrusive, professional",
      dramatic: "intense, building tension",
      conversational: "warm, friendly, light"
    };

    const styleDesc = styleDescriptors[style as keyof typeof styleDescriptors] || "ambient";
    const toneDesc = toneDescriptors[tone as keyof typeof toneDescriptors] || "neutral";

    return `${basePrompt}, ${styleDesc}, ${toneDesc}`;
  }

  private buildSystemPrompt(params: StoryRequest & { imageStyle?: string }): string {
    return `You are a skilled scriptwriter. Create the podcast script as requested, then convert the dialogue into the specified scene format. Each scene represents a cohesive segment of the podcast with its own visual setting and can contain multiple dialogue segments from the same or different speakers.
    
Track all named entities (characters, objects, specific locations) throughout the script. Assign each a unique identifier and count their appearances across scenes.`;
  }

  private buildAudioOnlySystemPrompt(params: StoryRequest): string {
    return `You are a skilled podcast scriptwriter. Create an engaging ${params.duration}-minute ${params.style} style podcast script with a ${params.tone} tone about: ${params.story}.

Focus purely on audio content - compelling dialogue, sound design cues, and narrative flow. No visual elements needed.`;
  }


private buildUserPrompt(params: StoryRequest & { imageStyle?: string }): string {
    // Handle voice assignment properly
    let speakerInfo: string;
    if (params.speakers === 'dual' && params.voices.length >= 2) {
      speakerInfo = `Use both voices naturally: '${params.voices[0]}' and '${params.voices[1]}'. Speakers can have multiple consecutive lines, and scenes don't need to include both voices - use what makes narrative sense.`;
    } else {
      // Single speaker mode OR dual mode with only one voice provided
      const voiceToUse = params.voices[0];
      speakerInfo = `Use only voice: '${voiceToUse}' for all dialogue. A scene can have one or multiple dialogue segments from this speaker.`;
    }

    const musicPrompt = this.buildMusicPrompt(params.style, params.tone);
    const imageStyle = params.imageStyle || 'realistic'; // Default fallback

    return `Create an intriguing ${params.duration}-minute ${params.style} style podcast script with a ${params.tone} tone about: ${params.story}.

The script MUST include:
- An INTRO scene: welcome the audience, introduce the theme, and set curiosity and intrigue.
- Multiple middle scenes: balance narrative storytelling with explanatory commentary that clarifies context.
- An OUTRO scene: summarize key insights, reflect on the journey, and leave the audience with a closing thought or question.

Write in a documentary podcast style: clear, engaging, and conversational.
- Blend storytelling with explanation — mix narrative anecdotes with factual context.
- Use rhetorical questions and smooth transitions to guide listeners.
- Keep the language accessible and understandable for a general audience while retaining depth.

Scene pacing:
- Each scene should last 2–5 minutes depending on content.
- Alternate between narrative description and explanatory breakdowns.
- Maintain suspense, curiosity, and narrative flow throughout.

Structure the output as a timed podcast with multiple scenes. Each scene represents a distinct visual/narrative segment and should have:
- A unique ID (scene_1, scene_2, etc.)
- A detailed image_prompt for the entire scene (${imageStyle} visual style, cinematic composition)
- Characters array: List any named entities appearing in this scene (people, named objects, named animals) with format: {name: "Entity Name", uuid: "char_[8-alphanumeric]"}
- Setting object (optional): If scene has a specific named location: {name: "Location Name", uuid: "setting_[8-alphanumeric]"}
- Inputs array containing dialogue segments for that scene

CRITICAL VISUAL STYLE REQUIREMENTS:
- ALL image_prompt descriptions must be in ${imageStyle} style
- For realistic: photorealistic, lifelike, natural lighting, authentic details
- For cartoon: animated, colorful, stylized characters, vibrant colors
- For comic: comic book art style, bold outlines, dramatic shading
- For drawing: hand-drawn illustration, artistic linework, sketched quality
- For watercolor: soft watercolor painting style, flowing colors, artistic brushstrokes
- For noir: black and white, high contrast, dramatic shadows, film noir aesthetic
- For sketch: pencil sketch style, rough lines, artistic drawing quality

CRITICAL ENTITY TRACKING RULES:
- Generate a unique 8-character alphanumeric ID for each distinct entity (character/object/animal) and location
- Format: "char_abc12345" for characters/entities, "setting_xyz67890" for locations
- Use the EXACT SAME UUID when the same entity appears in multiple scenes
- Generic descriptions like "a person" or "the street" do NOT get UUIDs - only named/specific entities
- Track named objects (like "Sally the Mustang") as characters too

${speakerInfo}

For dialogue flow:
- Speakers can have multiple consecutive inputs (natural conversation flow)
- Break dialogue into inputs based on natural speech segments, not artificial alternation
- Each input should be a complete thought or statement (typically 1-3 sentences)
- Scenes should flow naturally - don't force alternation between speakers

For each input in the inputs array, include:
- text: the actual spoken content (complete thought/statement)
- voice_id: the voice to use (${params.voices[0]}${params.voices.length >= 2 ? ` or ${params.voices[1]}` : ''})

Calculate scene timing based on approximately 160 words per minute speaking pace. No SFX, music cues, or scene directions beyond the dialogue.

Create detailed image prompts for each scene in ${imageStyle} style that capture the visual setting and mood for that entire segment of the podcast.

IMPORTANT: Include this exact music prompt in your metadata: "${musicPrompt}"

In metadata, include:
- imageStyle: "${imageStyle}" 
- anchors object with characters and settings arrays
- themes array listing recurring motifs

CRITICAL DESCRIPTION REQUIREMENTS:

For CHARACTER descriptions:
- Use generic descriptive names instead of real historical figures (e.g., "Apollo 11 Lunar Module Pilot" instead of "Buzz Aldrin", "Mission Commander" instead of "Neil Armstrong")
- In the "description" field, focus on period-appropriate details and professional context
- Describe profession-typical clothing, general build, and era-appropriate styling
- Avoid specific facial features, distinctive personal characteristics, or unique identifying traits
- Focus on archetypal representations of the profession/role
- Use descriptors like "astronaut from the Apollo program," "scientist from that era," "explorer from the period"
- Include relevant historical context like mission details, equipment, and setting
- ALWAYS end character descriptions with: "This is a fictional representation inspired by the historical period, not depicting any specific individual"

For SETTING descriptions:
- Provide detailed architectural, environmental, and atmospheric descriptions in ${imageStyle} style
- Include specific period details like materials, construction methods, lighting conditions
- Describe the mood, weather, time of day, and seasonal elements
- Include relevant historical context and geographical features

Return as JSON with the exact structure: title, totalDuration, estimatedWordsPerMinute, scenes array, and metadata object including speechStyle, imageStyle, musicPrompt, anchors, and themes.

Focus on suspense, narrative flow, and respectful fact-grounded storytelling using original fictional characters.`;
  }

  private buildAudioOnlyUserPrompt(params: StoryRequest): string {
    // Handle voice assignment properly
    let speakerInfo: string;
    if (params.speakers === 'dual' && params.voices.length >= 2) {
      speakerInfo = `Use both voices naturally: '${params.voices[0]}' and '${params.voices[1]}'. Speakers can have multiple consecutive lines, and scenes don't need to include both voices.`;
    } else {
      // Single speaker mode OR dual mode with only one voice provided
      const voiceToUse = params.voices[0];
      speakerInfo = `Use only voice: '${voiceToUse}' for all dialogue.`;
    }

    const musicPrompt = this.buildMusicPrompt(params.style, params.tone);

    return `Create an engaging ${params.duration}-minute ${params.style} style podcast script with a ${params.tone} tone about: ${params.story}.

Since this is audio-only content, focus entirely on:
- Compelling dialogue and narration
- Natural conversation flow
- Audio pacing and rhythm
- Sound atmosphere through words

The script MUST include:
- An INTRO scene: welcome the audience, introduce the theme, and set curiosity and intrigue.
- Multiple middle scenes: balance narrative storytelling with explanatory commentary that clarifies context.
- An OUTRO scene: summarize key insights, reflect on the journey, and leave the audience with a closing thought or question.

Write in a documentary podcast style: clear, engaging, and conversational.
- Blend storytelling with explanation — mix narrative anecdotes with factual context.
- Use rhetorical questions and smooth transitions to guide listeners.
- Keep the language accessible and understandable for a general audience while retaining depth.

Scene pacing:
- Each scene should last 2–5 minutes depending on content.
- Alternate between narrative description and explanatory breakdowns.
- Maintain suspense, curiosity, and narrative flow throughout.

Structure as timed scenes for audio mixing purposes. Each scene should have:
- A unique ID (scene_1, scene_2, etc.)
- Duration and timing information
- Inputs array containing dialogue segments

${speakerInfo}

For dialogue flow:
- Speakers can have multiple consecutive inputs (natural conversation flow)
- Break dialogue into inputs based on natural speech segments, not artificial alternation
- Each input should be a complete thought or statement (typically 1-3 sentences)
- Scenes should flow naturally - don't force alternation between speakers

For each input: include text (spoken content) and voice_id (always use: ${params.voices[0]}${params.voices.length >= 2 ? ` or ${params.voices[1]}` : ''}).

Calculate timing based on approximately 160 words per minute speaking pace.

Include this exact music prompt in metadata: "${musicPrompt}"

Return as JSON with title, totalDuration, estimatedWordsPerMinute, scenes array, and metadata object including speechStyle, musicPrompt, and themes.

Focus on audio storytelling, narrative flow, and engaging content.`;
  }

  private getVideoSchema() {
    return {
      type: "object",
      properties: {
        title: { type: "string" },
        totalDuration: { type: "number" },
        estimatedWordsPerMinute: { type: "number" },
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              startTime: { type: "number" },
              duration: { type: "number" },
              wordCount: { type: "number" },
              image_prompt: { type: "string" },
              characters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    uuid: { type: "string" }
                  },
                  required: ["name", "uuid"],
                  additionalProperties: false
                }
              },
              setting: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  uuid: { type: "string" }
                },
                required: ["name", "uuid"],
                additionalProperties: false
              },
              inputs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    voice_id: { type: "string" }
                  },
                  required: ["text", "voice_id"],
                  additionalProperties: false
                }
              }
            },
            required: ["id", "startTime", "duration", "wordCount", "image_prompt", "characters", "setting", "inputs"],
            additionalProperties: false
          }
        },
        metadata: {
          type: "object",
          properties: {
            totalScenes: { type: "number" },
            averageSceneDuration: { type: "number" },
            totalWords: { type: "number" },
            estimationMethod: { type: "string" },
            speechStyle: { type: "string" },
            imageStyle: { type: "string" },
            musicPrompt: { type: "string" },
            anchors: {
              type: "object",
              properties: {
                characters: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      uuid: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                      appearances: { type: "number" }
                    },
                    required: ["uuid", "name", "description", "appearances"],
                    additionalProperties: false
                  }
                },
                settings: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      uuid: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                      appearances: { type: "number" }
                    },
                    required: ["uuid", "name", "description", "appearances"],
                    additionalProperties: false
                  }
                }
              },
              required: ["characters", "settings"],
              additionalProperties: false
            },
            themes: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["totalScenes", "averageSceneDuration", "totalWords", "estimationMethod", "speechStyle", "imageStyle", "musicPrompt", "anchors", "themes"],
          additionalProperties: false
        }
      },
      required: ["title", "totalDuration", "estimatedWordsPerMinute", "scenes", "metadata"],
      additionalProperties: false
    };
  }

  private getAudioOnlySchema() {
    return {
      type: "object",
      properties: {
        title: { type: "string" },
        totalDuration: { type: "number" },
        estimatedWordsPerMinute: { type: "number" },
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              startTime: { type: "number" },
              duration: { type: "number" },
              wordCount: { type: "number" },
              inputs: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    voice_id: { type: "string" }
                  },
                  required: ["text", "voice_id"],
                  additionalProperties: false
                }
              }
            },
            required: ["id", "startTime", "duration", "wordCount", "inputs"],
            additionalProperties: false
          }
        },
        metadata: {
          type: "object",
          properties: {
            totalScenes: { type: "number" },
            averageSceneDuration: { type: "number" },
            totalWords: { type: "number" },
            estimationMethod: { type: "string" },
            speechStyle: { type: "string" },
            musicPrompt: { type: "string" },
            themes: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["totalScenes", "averageSceneDuration", "totalWords", "estimationMethod", "speechStyle", "musicPrompt", "themes"],
          additionalProperties: false
        }
      },
      required: ["title", "totalDuration", "estimatedWordsPerMinute", "scenes", "metadata"],
      additionalProperties: false
    };
  }

  async generateStory(userId: string, params: StoryRequest & { video: boolean; imageStyle?: string }): Promise<string> {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key is not configured');
      }

      // 1. Create story record with video flag
      const story = await prisma.story.create({
        data: {
          user_id: userId,
          style: params.style,
          speakers: params.speakers,
          voices: JSON.stringify(params.voices),
          tone: params.tone,
          duration: params.duration,
          video: params.video,
          status: 'pending'
        }
      });

      // 2. Build prompts based on video flag
      const systemPrompt = params.video 
        ? this.buildSystemPrompt(params)
        : this.buildAudioOnlySystemPrompt(params);

      const userPrompt = params.video
        ? this.buildUserPrompt(params)
        : this.buildAudioOnlyUserPrompt(params);

      // 3. Get schema based on video flag
      const schema = params.video 
        ? this.getVideoSchema()
        : this.getAudioOnlySchema();

      // 4. Call OpenAI API with appropriate configuration
      logger.info(`Calling OpenAI API for ${params.video ? 'video' : 'audio-only'} script generation...`);
      
      const response = await axios.post(
        'https://api.openai.com/v1/responses',
        {
          model: "gpt-5-2025-08-07",
          input: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user", 
              content: userPrompt
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "podcast_script",
              schema: schema,
              strict: true
            }
          },
          background: true,
          tools: [
            { type: "web_search_preview" }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const openaiResponse: OpenAIResponse = response.data;

      // 5. Save response_id and update status
      await Promise.all([
        prisma.story.update({
          where: { id: story.id },
          data: { 
            response_id: openaiResponse.id,
            status: 'processing'
          }
        }),
        prisma.response.create({
          data: {
            response_id: openaiResponse.id,
            type: 'script'
          }
        })
      ]);

      logger.info(`Story created: ${story.id}, Response ID: ${openaiResponse.id}, Mode: ${params.video ? 'video' : 'audio-only'}`);
      return story.id;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error(`OpenAI API Error: ${error.response?.status} - ${JSON.stringify(error.response?.data)}`);
      } else {
        logger.error(`Failed to generate story: ${error}`);
      }
      throw new Error('Failed to create story');
    }
  }
}