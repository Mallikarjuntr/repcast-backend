import { DescribeVoicesCommand, PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import { validatePhrases } from './phrases.js';

// Polly throttles bursts ("Rate exceeded" on 2026-10-19 with 4 at a time and the default 3 tries):
// fewer at once, and adaptive retries that slow down when told to.
const polly = new PollyClient({ maxAttempts: 10, retryMode: 'adaptive' });
const LANGUAGE = 'en-IN';
const PREFERRED_VOICE = 'Kajal';
const PARALLEL = 2;

interface VoiceEvent {
  phrases: unknown;
}

/**
 * Records the coach's lines with Amazon Polly. Invoked only by the deploy workflow (no public
 * route), which bundles the clips into the TV app. Returns each clip as base64 MP3.
 */
export async function handler(event: VoiceEvent) {
  const phrases = validatePhrases(event?.phrases);

  // Kajal (Indian English, neural) when this Region offers it; otherwise the best en-IN voice here.
  const voices = (await polly.send(new DescribeVoicesCommand({ LanguageCode: LANGUAGE }))).Voices ?? [];
  const voice =
    voices.find((v) => v.Id === PREFERRED_VOICE && v.SupportedEngines?.includes('neural')) ??
    voices.find((v) => v.SupportedEngines?.includes('neural')) ??
    voices[0];
  if (!voice?.Id) throw new Error(`No ${LANGUAGE} voice available in this Region`);
  const engine: Engine = voice.SupportedEngines?.includes('neural') ? 'neural' : 'standard';

  const clips: Record<string, string> = {};
  for (let i = 0; i < phrases.length; i += PARALLEL) {
    await Promise.all(
      phrases.slice(i, i + PARALLEL).map(async ({ id, text }) => {
        const out = await polly.send(
          new SynthesizeSpeechCommand({
            Text: text,
            VoiceId: voice.Id as VoiceId,
            Engine: engine,
            LanguageCode: LANGUAGE,
            OutputFormat: 'mp3',
            SampleRate: engine === 'neural' ? '24000' : '22050',
          }),
        );
        if (!out.AudioStream) throw new Error(`No audio for ${id}`);
        clips[id] = Buffer.from(await out.AudioStream.transformToByteArray()).toString('base64');
      }),
    );
  }

  return { voice: voice.Id, engine, lines: phrases.length, characters: phrases.reduce((n, p) => n + p.text.length, 0), clips };
}
