import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { isValidCode, newCode, newSession, sessionKey, type Session } from './sessions.js';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
const MAX_CODE_ATTEMPTS = 8;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(): Promise<APIGatewayProxyResultV2> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const session = newSession(newCode());
    try {
      await db.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { ...sessionKey(session.code), ...session },
          // A live session already holds this code; try another one.
          ConditionExpression: 'attribute_not_exists(pk) OR #ttl < :now',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
        }),
      );
      return json(201, { code: session.code, channel: session.channel, expiresAt: session.ttl });
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }
  return json(503, { error: 'No free pairing code right now. Try again.' });
}

async function getSession(code: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!isValidCode(code)) return json(400, { error: 'The code is 6 digits.' });
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: sessionKey(code) }));
  const session = Item as Session | undefined;
  if (!session || session.ttl < Math.floor(Date.now() / 1000)) {
    return json(404, { error: 'That code has expired or does not exist.' });
  }
  return json(200, { code: session.code, channel: session.channel, expiresAt: session.ttl });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    switch (event.routeKey) {
      case 'GET /health':
        return json(200, { ok: true });
      case 'POST /sessions':
        return await createSession();
      case 'GET /sessions/{code}':
        return await getSession(event.pathParameters?.code);
      default:
        return json(404, { error: 'Not found' });
    }
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Something went wrong.' });
  }
}
