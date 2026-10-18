import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { sessionKey } from '../api/sessions.js';
import { AnalysisRequest, Report, SYSTEM_PROMPT, userMessage } from './report.js';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
const BEDROCK_REGION = process.env.BEDROCK_REGION ?? 'us-east-1';
/**
 * Inference profiles to try, in order. Haiku first: the numbers are summarised in code, so the
 * writing is light, and Haiku answers fastest at a fraction of Opus's price. The org account's keys
 * allow the classic InvokeModel API but not the newer bedrock-mantle one, and which models they
 * reach can't be listed from here, so a model that's refused or unknown is skipped and the first
 * that answers is kept for the container.
 */
const MODELS = (process.env.BEDROCK_MODELS ?? 'global.anthropic.claude-haiku-5-5,global.anthropic.claude-opus-5-5,global.anthropic.claude-opus-5,global.anthropic.claude-opus-4-8')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
/** API Gateway gives up at 30 s: don't start another model after this. */
const LAST_START_MS = 14_000;
const KEY_ID_PARAM = process.env.KEY_ID_PARAM ?? '/spotter/bedrock/access-key-id';
const SECRET_PARAM = process.env.SECRET_PARAM ?? '/spotter/bedrock/secret-access-key';
/** Reports one pairing session may ask for: the endpoint is public and each report costs money. */
const MAX_PER_SESSION = 10;
const MAX_BODY_BYTES = 32_000;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
let bedrock: AnthropicBedrock | null = null;
/** Index into MODELS of the last model that answered. */
let working = 0;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The Bedrock keys live encrypted in Parameter Store (never in code or config); read once per container. */
async function client(): Promise<AnthropicBedrock> {
  if (bedrock) return bedrock;
  const { Parameters = [] } = await ssm.send(new GetParametersCommand({ Names: [KEY_ID_PARAM, SECRET_PARAM], WithDecryption: true }));
  const value = (name: string) => Parameters.find((p) => p.Name === name)?.Value;
  const awsAccessKey = value(KEY_ID_PARAM);
  const awsSecretKey = value(SECRET_PARAM);
  if (!awsAccessKey || !awsSecretKey) throw new Error('Bedrock keys are missing from Parameter Store');
  bedrock = new AnthropicBedrock({ awsRegion: BEDROCK_REGION, awsAccessKey, awsSecretKey, maxRetries: 0, timeout: 20_000 });
  return bedrock;
}

/** Errors that say "this model isn't available to these keys" (unknown id, no access, not enabled), not "Bedrock is down". */
const tryNext = (err: unknown) => err instanceof Anthropic.APIError && (err.status === 400 || err.status === 403 || err.status === 404);

async function writeReport(content: string): Promise<Report | null> {
  const bedrock = await client();
  const started = Date.now();
  for (let i = 0; i < MODELS.length && Date.now() - started < LAST_START_MS; i++) {
    const at = (working + i) % MODELS.length;
    const model = MODELS[at]!;
    try {
      const response = await bedrock.messages.parse({
        model,
        max_tokens: 8000,
        // Low effort keeps the wait short; the task is light.
        output_config: { effort: 'low', format: zodOutputFormat(Report) },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      });
      if (response.stop_reason !== 'refusal' && response.parsed_output) {
        working = at;
        console.log('report', { model, input: response.usage.input_tokens, output: response.usage.output_tokens });
        return response.parsed_output;
      }
      // A refusal or a malformed report: another model may still write it.
      console.error('No report', model, response.stop_reason);
    } catch (err) {
      if (!tryNext(err)) throw err;
      console.error('Skipping model', model, (err as InstanceType<typeof Anthropic.APIError>).status, (err as Error).message);
    }
  }
  return null;
}

/** One write checks the session is live and this TV's, and counts the report against its limit. */
async function useAllowance(code: string, channel: string): Promise<boolean> {
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: sessionKey(code),
        UpdateExpression: 'ADD analyses :one',
        ConditionExpression: 'attribute_exists(pk) AND channel = :channel AND #ttl > :now AND (attribute_not_exists(analyses) OR analyses < :max)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':channel': channel, ':now': Math.floor(Date.now() / 1000), ':max': MAX_PER_SESSION },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

async function analyse(body: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!body || body.length > MAX_BODY_BYTES) return json(400, { error: 'Send the workout as JSON.' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(400, { error: 'Send the workout as JSON.' });
  }
  const request = AnalysisRequest.safeParse(parsed);
  if (!request.success) return json(400, { error: "That workout doesn't look right." });
  if (request.data.attempts.length === 0) return json(400, { error: 'There are no reps to analyse yet.' });
  if (!(await useAllowance(request.data.code, request.data.channel))) {
    return json(403, { error: 'This session has ended or used its analyses. Start a new session to analyse again.' });
  }

  const report = await writeReport(userMessage(request.data));
  if (!report) return json(502, { error: "The coach couldn't write this one. Try again in a moment." });
  return json(200, { report });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.routeKey !== 'POST /coach/analysis') return json(404, { error: 'Not found' });
    const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return await analyse(body);
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.error('Bedrock error', err.status, err.message);
    else console.error(err);
    return json(502, { error: "The coach couldn't write this one. Try again in a moment." });
  }
}
