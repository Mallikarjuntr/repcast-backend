import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { BedrockRuntimeClient, BedrockRuntimeServiceException, ConverseCommand, type ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { sessionKey } from '../api/sessions.js';
import { AnalysisRequest, Report, SYSTEM_PROMPT, userMessage } from './report.js';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
/**
 * Models to try, in order; the first that answers is kept for the container. Three kinds:
 * - `org:<model id>`: any Bedrock model (Amazon Nova Lite, for one) in the org account, called with
 *   the keys kept in Parameter Store.
 * - Claude (`anthropic.` ids): also in the org account, with the same keys.
 * - Other ids (Amazon Nova): this account and region, called with the Lambda's own role.
 * A model that's refused or unknown is skipped (and logged with the reason).
 */
const MODELS = (process.env.BEDROCK_MODELS ?? 'in.anthropic.claude-haiku-4-5-20251001-v1:0,global.amazon.nova-2-lite-v1:0')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
/** Region of the org account's models (its policy allows Claude Haiku 4.5 through the India profile). */
const ORG_REGION = process.env.ORG_REGION ?? process.env.CLAUDE_REGION ?? 'ap-south-1';
/** API Gateway gives up at 30 s: don't start another model after this. */
const LAST_START_MS = 14_000;
const KEY_ID_PARAM = process.env.KEY_ID_PARAM ?? '/spotter/bedrock/access-key-id';
const SECRET_PARAM = process.env.SECRET_PARAM ?? '/spotter/bedrock/secret-access-key';
/** Reports one pairing session may ask for: the endpoint is public and each report costs money. */
const MAX_PER_SESSION = 10;
const MAX_BODY_BYTES = 32_000;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const runtime = new BedrockRuntimeClient({ maxAttempts: 1, requestHandler: { requestTimeout: 20_000 } });
let claude: AnthropicBedrock | null = null;
let orgRuntime: BedrockRuntimeClient | null = null;
let orgKeysCache: { accessKeyId: string; secretAccessKey: string } | null = null;
/** Index into MODELS of the last model that answered. */
let working = 0;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The org account's keys live encrypted in Parameter Store (never in code or config); read once per container. */
async function orgKeys(): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  if (orgKeysCache) return orgKeysCache;
  const { Parameters = [] } = await ssm.send(new GetParametersCommand({ Names: [KEY_ID_PARAM, SECRET_PARAM], WithDecryption: true }));
  const value = (name: string) => Parameters.find((p) => p.Name === name)?.Value;
  const accessKeyId = value(KEY_ID_PARAM);
  const secretAccessKey = value(SECRET_PARAM);
  if (!accessKeyId || !secretAccessKey) throw new Error('Bedrock keys are missing from Parameter Store');
  orgKeysCache = { accessKeyId, secretAccessKey };
  return orgKeysCache;
}

async function claudeClient(): Promise<AnthropicBedrock> {
  if (claude) return claude;
  const { accessKeyId: awsAccessKey, secretAccessKey: awsSecretKey } = await orgKeys();
  claude = new AnthropicBedrock({ awsRegion: ORG_REGION, awsAccessKey, awsSecretKey, maxRetries: 0, timeout: 20_000 });
  return claude;
}

async function orgRuntimeClient(): Promise<BedrockRuntimeClient> {
  orgRuntime ??= new BedrockRuntimeClient({ region: ORG_REGION, credentials: await orgKeys(), maxAttempts: 1, requestHandler: { requestTimeout: 20_000 } });
  return orgRuntime;
}

/** Some models return the report as the input of a tool they're told to call (a way of getting JSON back). */
const { $schema: _, ...reportSchema } = z.toJSONSchema(Report) as Record<string, unknown>;
const REPORT_TOOL = { name: 'write_report', description: 'Hand the finished report to the TV.' };

/**
 * Claude 4.5 and older (Haiku 4.5 is what the org account allows) don't take the effort setting,
 * and structured output isn't on every Bedrock route for them, so they hand the report back as a
 * tool call they're told to make, which every Claude model on Bedrock supports. Newer models use
 * structured output (they reject forced tool calls).
 */
const olderClaude = (model: string) => /claude-(haiku|sonnet|opus)-4-[0-5]|claude-3/.test(model);

async function claudeReport(model: string, content: string): Promise<Report | null> {
  const client = await claudeClient();
  if (olderClaude(model)) {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [{ ...REPORT_TOOL, input_schema: reportSchema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: 'tool', name: REPORT_TOOL.name },
      messages: [{ role: 'user', content }],
    });
    console.log('usage', { model, input: response.usage.input_tokens, output: response.usage.output_tokens, stop: response.stop_reason });
    const call = response.content.find((block) => block.type === 'tool_use');
    const report = Report.safeParse(call?.type === 'tool_use' ? call.input : null);
    if (!report.success) console.error('Bad report', model, report.error.message.slice(0, 500));
    return report.success ? report.data : null;
  }
  const response = await client.messages.parse({
    model,
    max_tokens: 8000,
    // Low effort keeps the wait short; the task is light.
    output_config: { effort: 'low', format: zodOutputFormat(Report) },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });
  console.log('usage', { model, input: response.usage.input_tokens, output: response.usage.output_tokens, stop: response.stop_reason });
  return response.stop_reason !== 'refusal' ? response.parsed_output : null;
}


async function novaReport(model: string, content: string, client: BedrockRuntimeClient = runtime): Promise<Report | null> {
  const out = await client.send(
    new ConverseCommand({
      modelId: model,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: content }] }],
      inferenceConfig: { maxTokens: 2000, temperature: 0.4 },
      toolConfig: {
        tools: [{ toolSpec: { ...REPORT_TOOL, inputSchema: { json: reportSchema } as ToolInputSchema } }],
        toolChoice: { tool: { name: REPORT_TOOL.name } },
      },
    }),
  );
  console.log('usage', { model, input: out.usage?.inputTokens, output: out.usage?.outputTokens, stop: out.stopReason });
  const call = out.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
  const report = Report.safeParse(call?.input);
  if (!report.success) console.error('Bad report', model, report.error.message.slice(0, 500));
  return report.success ? report.data : null;
}

/** Errors that say "this model isn't available here" (unknown id, no access, not enabled), not "Bedrock is down". */
function unavailable(err: unknown): number | null {
  const status =
    err instanceof Anthropic.APIError ? err.status : err instanceof BedrockRuntimeServiceException ? err.$metadata.httpStatusCode : undefined;
  return status === 400 || status === 403 || status === 404 ? status : null;
}

async function writeReport(content: string): Promise<(Report & { writtenBy: string }) | null> {
  const started = Date.now();
  for (let i = 0; i < MODELS.length && Date.now() - started < LAST_START_MS; i++) {
    const at = (working + i) % MODELS.length;
    const model = MODELS[at]!;
    const org = model.startsWith('org:');
    const id = org ? model.slice(4) : model;
    const claudeModel = id.includes('anthropic.');
    try {
      const report = claudeModel ? await claudeReport(id, content) : await novaReport(id, content, org ? await orgRuntimeClient() : runtime);
      if (report) {
        working = at;
        return { ...report, writtenBy: claudeModel ? 'Claude' : 'Amazon Nova' };
      }
      // A refusal or a malformed report: another model may still write it.
    } catch (err) {
      const status = unavailable(err);
      if (status === null) throw err;
      console.error('Skipping model', model, status, (err as Error).message);
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
