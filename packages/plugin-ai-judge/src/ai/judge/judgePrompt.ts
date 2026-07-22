import { readFileSync } from 'fs';

import type { JudgeInput } from '../types.js';

/** System prompt for RUBRIC mode: evaluate the material against text criteria. */
export const SYSTEM_PROMPT =
  'You are a strict QA judge. Evaluate the provided material — the bot response text and/or ' +
  'the attached image — ONLY against the rubric. When only an image is provided, judge the ' +
  'image against the rubric and do NOT penalize the absence of text. ' +
  'Reply with ONLY a JSON object: {"pass": boolean, "score": number 0-100, "reasoning": string}. ' +
  'Do not include any text outside the JSON.';

/** System prompt for COMPARE mode: decide whether the actual image matches the expected reference. */
export const COMPARE_SYSTEM_PROMPT =
  'You are a strict visual QA judge. Two images are attached: the FIRST is the ACTUAL result and ' +
  'the SECOND is the EXPECTED reference. Decide whether the actual matches the expected. If ' +
  'comparison criteria are provided, apply them; otherwise judge the overall visual equivalence of ' +
  'the depicted content and ignore trivial rendering differences. ' +
  'Reply with ONLY a JSON object: {"pass": boolean, "score": number 0-100, "reasoning": string}. ' +
  'Do not include any text outside the JSON.';

/**
 * Build the user message text for either mode. Empty sections are omitted. In compare mode it
 * labels the two attached images (actual, then reference); in rubric image-only mode it points the
 * judge at the image so it does not treat missing text as "no content to evaluate".
 */
export function buildUserText(input: JudgeInput): string {
  const compareMode = input.referenceImage !== undefined;
  const parts: string[] = [];

  if (input.rubric) {
    parts.push(`${compareMode ? 'COMPARISON CRITERIA' : 'RUBRIC'}:\n${input.rubric}`);
  }
  if (input.userMessage) {
    parts.push(`USER MESSAGE:\n${input.userMessage}`);
  }
  if (input.botResponse) {
    parts.push(`BOT RESPONSE:\n${input.botResponse}`);
  }

  if (compareMode) {
    parts.push(
      'MATERIAL TO EVALUATE: two images are attached — the FIRST is the ACTUAL result, the SECOND ' +
        'is the EXPECTED reference. Decide whether the actual matches the expected.',
    );
  } else if (!input.botResponse && input.image !== undefined) {
    parts.push('MATERIAL TO EVALUATE: the attached image (there is no text response).');
  }

  return parts.join('\n\n');
}

/**
 * Ordered images for a judging call: the actual image first, then the reference (compare mode).
 * Empty when the call is text-only.
 */
export function collectImages(input: JudgeInput): Array<string | Buffer> {
  const images: Array<string | Buffer> = [];
  if (input.image !== undefined) {
    images.push(input.image);
  }
  if (input.referenceImage !== undefined) {
    images.push(input.referenceImage);
  }

  return images;
}

/** Raw base64 (no data: prefix) — the format Ollama's native API expects in `images`. */
export function imageToBase64(image: string | Buffer): string {
  if (Buffer.isBuffer(image)) {
    return image.toString('base64');
  }
  if (image.startsWith('data:')) {
    return image.replace(/^data:[^;]+;base64,/, '');
  }

  return readFileSync(image).toString('base64');
}

/** Data URI — the format an OpenAI-style `image_url` content part expects. */
export function imageToDataUri(image: string | Buffer): string {
  if (Buffer.isBuffer(image)) {
    return `data:image/png;base64,${image.toString('base64')}`;
  }
  if (image.startsWith('data:')) {
    return image;
  }

  const ext = image.split('.').pop()?.toLowerCase();
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : ext === 'gif'
          ? 'image/gif'
          : 'image/png';

  return `data:${mime};base64,${readFileSync(image).toString('base64')}`;
}
