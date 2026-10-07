export const SUGGESTIONS = [
  'Write a project proposal',
  'Write a functional spec document',
  'Write a technical spec document',
];

/** One entry of the model switcher's `models` property. Named here because
 *  the controller carries the list as a State field and the generated react
 *  tree types that field. */
export interface ModelOption {
  id: string;
  name: string;
  description?: string;
}

export const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: 'Via LiteLLM + opencode' },
];
