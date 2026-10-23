import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { BedrockRuntimeClient, BedrockRuntimeServiceException, ConverseCommand, type ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { sessionKey } from '../api/sessions.js';
import { AnalysisRequest, Report, SYSTEM_PROMPT, userMessage } from './report.js';
import { firstAnswer } from './retry.js';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
/**
 * Models to try, in order; the first that answers is kept for the container. Three kinds:
 * - `org:<model id>`: any Bedrock model (Amazon Nova Lite, for one) in the org account, called with
 *   the keys kept in Parameter Store.
 * - Claude (`anthropic.` ids): also in the org account, with the same keys.
 * - Other ids (Amazon Nova): this account and region, called with the Lambda's own role.
 * A model that's refused or unknown is skipped (and logged with the reason).
 */
const MODELS = (process.env.BEDROCK_MODELS ?? 'org:apac.amazon.nova-lite-v1:0,in.anthropic.claude-haiku-4-5-20251001-v1:0,global.amazon.nova-2-lite-v1:0')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
/** Region of the org account's models (its policy allows Claude Haiku 4.5 through the India profile). */
const ORG_REGION = process.env.ORG_REGION ?? process.env.CLAUDE_REGION ?? 'ap-south-1';
/** A report takes 1.5–3 s; a call that's still going after this is cut off and made again. */
const ATTEMPT_MS = 7_000;
/** API Gateway gives up at 30 s: no call starts after this (so at most about 18 + 7 s, plus set-up). */
const LAST_START_MS = 18_000;
const KEY_ID_PARAM = process.env.KEY_ID_PARAM ?? '/spotter/bedrock/access-key-id';
const SECRET_PARAM = process.env.SECRET_PARAM ?? '/spotter/bedrock/secret-access-key';
/**
 * The endpoint is public and each report costs money (about $0.0003 on Nova Lite; budgeted at
 * $0.005), so: 3 per move and 10 per pairing session (a session lives 2 hours), and 150 a day for
 * everyone together, which caps the worst case near $0.75 a day. The TV's charts don't need the AI.
 */
const MAX_PER_MOVE = 3;
const MAX_PER_SESSION = 10;
const MAX_PER_DAY = 150;
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

async function claudeReport(model: string, content: string, signal?: AbortSignal): Promise<Report | null> {
  const client = await claudeClient();
  if (olderClaude(model)) {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [{ ...REPORT_TOOL, input_schema: reportSchema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: 'tool', name: REPORT_TOOL.name },
      messages: [{ role: 'user', content }],
    }, { signal });
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
  }, { signal });
  console.log('usage', { model, input: response.usage.input_tokens, output: response.usage.output_tokens, stop: response.stop_reason });
  return response.stop_reason !== 'refusal' ? response.parsed_output : null;
}


async function novaReport(model: string, content: string, client: BedrockRuntimeClient = runtime, signal?: AbortSignal): Promise<Report | null> {
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
    { abortSignal: signal },
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
  const answer = await firstAnswer(
    MODELS.length,
    working,
    async (index, signal) => {
      const model = MODELS[index]!;
      const org = model.startsWith('org:');
      const id = org ? model.slice(4) : model;
      return id.includes('anthropic.') ? claudeReport(id, content, signal) : novaReport(id, content, org ? await orgRuntimeClient() : runtime, signal);
    },
    {
      attemptMs: ATTEMPT_MS,
      lastStartMs: LAST_START_MS,
      skip: (err) => unavailable(err) !== null,
      onError: (index, err, skipped) => console.error(skipped ? 'Skipping model' : 'Asking again', MODELS[index], unavailable(err) ?? (err as Error).name, (err as Error).message),
    },
  );
  if (!answer) return null;
  working = answer.index;
  return { ...answer.value, writtenBy: MODELS[answer.index]!.includes('anthropic.') ? 'Claude' : 'Amazon Nova' };
}

type Allowance = { ok: true; left: { move: number; session: number }; day: string } | { ok: false; status: number; error: string };

/**
 * Checks the session is live and this TV's and that the limits allow one more report, then counts
 * it against the session, the move and the day in one transaction (so two TVs can't both take the
 * last one).
 */
async function useAllowance(code: string, channel: string, moveId: string): Promise<Allowance> {
  const now = Math.floor(Date.now() / 1000);
  const moveAttr = `analyses_${moveId}`;
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: sessionKey(code) }));
  if (!Item || Item.channel !== channel || Item.ttl <= now) {
    return { ok: false, status: 403, error: 'This session has ended. Start a new session to analyse again.' };
  }
  const session = Number(Item.analyses ?? 0);
  const move = Number(Item[moveAttr] ?? 0);
  if (move >= MAX_PER_MOVE) {
    return { ok: false, status: 429, error: `That's all ${MAX_PER_MOVE} AI notes for this move this session. Your charts are all here — or try another move.` };
  }
  if (session >= MAX_PER_SESSION) {
    return { ok: false, status: 429, error: `This session has used its ${MAX_PER_SESSION} AI notes. Your charts are all here; pair again later for more.` };
  }
  const day = new Date().toISOString().slice(0, 10);
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: sessionKey(code),
              UpdateExpression: 'ADD analyses :one, #mv :one',
              ConditionExpression: 'channel = :channel AND #ttl > :now AND (attribute_not_exists(analyses) OR analyses < :maxSession) AND (attribute_not_exists(#mv) OR #mv < :maxMove)',
              ExpressionAttributeNames: { '#ttl': 'ttl', '#mv': moveAttr },
              ExpressionAttributeValues: { ':one': 1, ':channel': channel, ':now': now, ':maxSession': MAX_PER_SESSION, ':maxMove': MAX_PER_MOVE },
            },
          },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { pk: `COACH#DAY#${day}`, sk: 'META' },
              UpdateExpression: 'ADD reports :one SET #ttl = if_not_exists(#ttl, :expires)',
              ConditionExpression: 'attribute_not_exists(reports) OR reports < :maxDay',
              ExpressionAttributeNames: { '#ttl': 'ttl' },
              ExpressionAttributeValues: { ':one': 1, ':maxDay': MAX_PER_DAY, ':expires': now + 3 * 24 * 60 * 60 },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (!(err instanceof TransactionCanceledException)) throw err;
    if (err.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed') {
      return { ok: false, status: 429, error: "RepCast's AI coach has written all its notes for today. Your charts are all here; try the AI note tomorrow." };
    }
    return { ok: false, status: 429, error: 'Someone else just asked too. Try again in a moment.' };
  }
  return { ok: true, left: { move: MAX_PER_MOVE - move - 1, session: MAX_PER_SESSION - session - 1 }, day };
}

/** A report that couldn't be written isn't counted, so the TV can simply ask again. */
async function giveBack(code: string, moveId: string, day: string): Promise<void> {
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE_NAME,
              Key: sessionKey(code),
              UpdateExpression: 'ADD analyses :minus, #mv :minus',
              ExpressionAttributeNames: { '#mv': `analyses_${moveId}` },
              ExpressionAttributeValues: { ':minus': -1 },
            },
          },
          { Update: { TableName: TABLE_NAME, Key: { pk: `COACH#DAY#${day}`, sk: 'META' }, UpdateExpression: 'ADD reports :minus', ExpressionAttributeValues: { ':minus': -1 } } },
        ],
      }),
    );
  } catch (err) {
    console.error('Could not give the note back', err);
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
  const allowance = await useAllowance(request.data.code, request.data.channel, request.data.move.id);
  if (!allowance.ok) return json(allowance.status, { error: allowance.error });

  // Shape only, never the numbers themselves: enough to tell a TV that sent no history from a model that ignored it.
  console.log('request', { move: request.data.move.id, attempts: request.data.attempts.length, previous: request.data.previous.length });
  let report: Awaited<ReturnType<typeof writeReport>>;
  try {
    report = await writeReport(userMessage(request.data));
  } catch (err) {
    await giveBack(request.data.code, request.data.move.id, allowance.day);
    throw err;
  }
  if (!report) {
    await giveBack(request.data.code, request.data.move.id, allowance.day);
    return json(502, { error: "The coach couldn't write this one. Try again in a moment." });
  }
  return json(200, { report, left: allowance.left });
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
