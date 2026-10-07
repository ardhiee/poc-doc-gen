# Assistant

Full-page assistant with a conversations rail: kai-conversations (built-in header, search and New chat), a kai-model-switcher recipe in the top bar, kai-thread plus kai-prompt-input, and the headless conversation controller over local storage. Ships with a scripted mock so the thread demos reasoning, a settled tool call and citations on first paint.

Render it: `import { Assistant } from './Assistant';`

Runs against a scripted local mock out of the box - no endpoint, no key. To go live, replace the mock responder in assistant.controller.ts with a fetch to your chat endpoint (send the selected model id with the request) and keep parsing through the @kitn.ai/ui/wire readers.
