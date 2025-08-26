export interface WebhookEvent {
  id: string;
  object: string;
  created_at: number;
  type: string;
  data: {
    id: string;
  };
}

export interface OpenAIResponseData {
  id: string;
  status: string;
  output?: Array<{
    type: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
}