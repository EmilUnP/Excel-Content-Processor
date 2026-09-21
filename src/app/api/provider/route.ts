import { NextResponse } from 'next/server';
import { isOpenRouterConfigured } from '@/lib/ai-provider';
import {
  getDefaultImageTranslateModel,
  getDefaultTranslationModel,
  getImageTextModel,
  getImageTranslateModels,
  getTranslationModels
} from '@/lib/model-config';

// Reads environment state, so it must not be baked in at build time.
export const dynamic = 'force-dynamic';

/**
 * Tells the browser how the AI side is configured.
 *
 * The model lists live in `.env` and are read per request, so editing them and
 * restarting is enough - no code change, no rebuild. Returns ids, labels and
 * costs only; never key material.
 */
export async function GET() {
  const configured = isOpenRouterConfigured();

  return NextResponse.json({
    provider: 'openrouter',
    configured,
    label: configured ? 'OpenRouter' : 'OpenRouter - no API key configured',
    translationModels: getTranslationModels(),
    defaultTranslationModel: getDefaultTranslationModel(),
    imageTextModel: getImageTextModel(),
    imageTranslateModels: getImageTranslateModels(),
    defaultImageTranslateModel: getDefaultImageTranslateModel()
  });
}
