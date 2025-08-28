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

  private buildSystemPrompt(params: StoryRequest): string {
    return `You are a skilled scriptwriter. Create the podcast script as requested, then convert the dialogue into the specified scene format. Each scene represents a cohesive segment of the podcast with its own visual setting and can contain multiple dialogue segments from the same or different speakers.
    
Track all named entities (characters, objects, specific locations) throughout the script. Assign each a unique identifier and count their appearances across scenes.`;
  }

private buildUserPrompt(params: StoryRequest): string {
  const speakerInfo = params.speakers === 'dual' 
    ? `Use both voices naturally: '${params.voices[0]}' and '${params.voices[1]}'. Speakers can have multiple consecutive lines, and scenes don't need to include both voices - use what makes narrative sense.`
    : `Use only voice: '${params.voices[0]}'. A scene can have one or multiple dialogue segments from this speaker.`;

  const musicPrompt = this.buildMusicPrompt(params.style, params.tone);

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
- A detailed image_prompt for the entire scene (cinematic, documentary-style visual description)
- Characters array: List any named entities appearing in this scene (people, named objects, named animals) with format: {name: "Entity Name", uuid: "char_[8-alphanumeric]"}
- Setting object (optional): If scene has a specific named location: {name: "Location Name", uuid: "setting_[8-alphanumeric]"}
- Inputs array containing dialogue segments for that scene

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
- voice_id: the voice to use (${params.voices[0]}${params.speakers === 'dual' ? ` or ${params.voices[1]}` : ''})

Calculate scene timing based on approximately 160 words per minute speaking pace. No SFX, music cues, or scene directions beyond the dialogue.

Create cinematic, detailed image prompts for each scene that capture the visual setting and mood for that entire segment of the podcast.

IMPORTANT: Include this exact music prompt in your metadata: "${musicPrompt}"

In metadata, include an "anchors" object with:
- characters: array of ALL named entities with {uuid, name, description, appearances}
- settings: array of ALL specific locations with {uuid, name, description, appearances}
Also include a "themes" array listing recurring motifs or concepts (e.g. "memory", "empire", "scientific discovery").

CRITICAL DESCRIPTION REQUIREMENTS:

For CHARACTER descriptions:
- Describe physical appearance, clothing, and period-appropriate details
- Focus on general historical accuracy rather than specific individual likeness
- For real historical figures: describe typical period clothing, general build, and era-appropriate styling
- ALWAYS end character descriptions with: "Generate as historically accurate representation, not a direct likeness of the real person"
- Example: "Roman general in ornate military dress with bronze breastplate, red cloak, and ceremonial helmet. Mature build with commanding presence typical of Roman leadership. Generate as historically accurate representation, not a direct likeness of the real person"

For SETTING descriptions:
- Provide detailed architectural, environmental, and atmospheric descriptions
- Include specific period details like materials, construction methods, lighting conditions
- Describe the mood, weather, time of day, and seasonal elements
- Include relevant historical context and geographical features
- Example: "Ancient Roman amphitheater with weathered limestone seats rising in tiers, marble columns supporting arched galleries, torch-lit corridors casting flickering shadows, Mediterranean afternoon light streaming through openings, scattered fallen leaves suggesting autumn, distant hills visible beyond the arena walls"

Description should be visual and specific to help with image generation consistency.
Only include entities that appear at least once in the story.

Return as JSON with the exact structure: title, totalDuration, estimatedWordsPerMinute, scenes array, and metadata object including speechStyle, imageStyle, musicPrompt, anchors, and themes.

Focus on suspense, narrative flow, and respectful fact-grounded storytelling.`;
}

  async generateStory(userId: string, params: StoryRequest): Promise<string> {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OpenAI API key is not configured');
      }

      // 1. Create story record
      const story = await prisma.story.create({
        data: {
          user_id: userId,
          style: params.style,
          speakers: params.speakers,
          voices: JSON.stringify(params.voices),
          tone: params.tone,
          duration: params.duration,
          status: 'pending'
        }
      });

      // 2. Call OpenAI API for script generation
      logger.info('Calling OpenAI API for script generation...');
      
      const response = await axios.post(
        'https://api.openai.com/v1/responses',
        {
          model: "gpt-5-2025-08-07",
          input: [
            {
              role: "system",
              content: this.buildSystemPrompt(params)
            },
            {
              role: "user", 
              content: this.buildUserPrompt(params)
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "podcast_script",
              schema: {
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
                      required: ["id", "startTime", "duration", "wordCount", "image_prompt", "characters", "setting", "inputs"], // Added characters and setting here
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
              },
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

      // 3. Save response_id and update status
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

      logger.info(`Story created: ${story.id}, Response ID: ${openaiResponse.id}`);
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