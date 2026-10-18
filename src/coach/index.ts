import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import Anthropic, { betaRefusalFallbackMiddleware } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { sessionKey } from '../api/sessions.js';
import { AnalysisRequest, Report, SYSTEM_PROMPT, userMessage } from './report.js';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
const BEDROCK_REGION = process.env.BEDROCK_REGION ?? 'us-east-1';
const MODEL = process.env.BEDROCK_MODEL ?? 'anthropic.claude-opus-5-5';
const FALLBACK_MODEL = process.env.BEDROCK_FALLBACK_MODEL ?? 'anthropic.claude-sonnet-5-5';
const KEY_ID_PARAM = process.env.KEY_ID_PARAM ?? '/spotter/bedrock/access-key-id';
const SECRET_PARAM = process.env.SECRET_PARAM ?? '/spotter/bedrock/secret-access-key';
/** Reports one pairing session may ask for: the endpoint is public and each report costs money. */
const MAX_PER_SESSION = 10;
const MAX_BODY_BYTES = 32_000;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
let bedrock: AnthropicBedrockMantle | null = null;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The Bedrock keys live encrypted in Parameter Store (never in code or config); read once per container. */
async function client(): Promise<AnthropicBedrockMantle> {
  if (bedrock) return bedrock;
  const { Parameters = [] } = await ssm.send(new GetParametersCommand({ Names: [KEY_ID_PARAM, SECRET_PARAM], WithDecryption: true }));
  const value = (name: string) => Parameters.find((p) => p.Name === name)?.Value;
  const awsAccessKey = value(KEY_ID_PARAM);
  const awsSecretAccessKey = value(SECRET_PARAM);
  if (!awsAccessKey || !awsSecretAccessKey) throw new Error('Bedrock keys are missing from Parameter Store');
  bedrock = new AnthropicBedrockMantle({
    awsRegion: BEDROCK_REGION,
    awsAccessKey,
    awsSecretAccessKey,
    // If Opus declines (its safety classifiers), the same request is retried on Sonnet.
    middleware: [betaRefusalFallbackMiddleware([{ model: FALLBACK_MODEL }])],
    maxRetries: 1,
    timeout: 25_000,
  });
  return bedrock;
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

  const response = await (await client()).messages.parse({
    model: MODEL,
    max_tokens: 8000,
    // Low effort keeps the wait short; the numbers are summarised in code, so the task is light.
    output_config: { effort: 'low', format: zodOutputFormat(Report) },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage(request.data) }],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    console.error('No report', response.stop_reason, response.stop_details ?? null);
    return json(502, { error: "The coach couldn't write this one. Try again in a moment." });
  }
  console.log('report', { model: response.model, input: response.usage.input_tokens, output: response.usage.output_tokens });
  return json(200, { report: response.parsed_output });
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
