# RepCast backend

AWS infrastructure and serverless functions for [RepCast](https://github.com/Mallikarjuntr/repcast-tv-app), defined as CloudFormation (AWS SAM) and deployed by GitHub Actions. No long-lived AWS keys are stored anywhere: Actions signs in to AWS through GitHub OIDC.

## What it creates

| Resource | Purpose | Cost notes |
|---|---|---|
| AppSync Events API (`spotter-events`) | Live link: the camera device publishes pose events, the TV subscribes (one channel per session) | ~$1 per million messages |
| HTTP API + Lambda (`spotter-api`) | `GET /health`, `POST /sessions` (new 4-digit pairing code), `GET /sessions/{code}` | Free tier; throttled to 10 req/s, code lookups to 2 req/s (trying all 10,000 codes takes over 80 minutes; a code lives 2 hours) |
| DynamoDB (`spotter-data`) | Pairing sessions (auto-expire after 2 hours via TTL) and the AI report counters. Workout history stays on the TV | Provisioned 2/2, inside the always-free tier |
| Amazon Polly + Lambda (`spotter-voice`) | Records the coach's voice: every line the TV says (counts, form cues, rest, finish) as an MP3 with the neural voice *Kajal*. The Deploy workflow runs it when `voice/phrases.json` changes and attaches the clips to the run; the TV app bundles them, because Fire TV's own text-to-speech is silent for apps. No public route | About $0.06 for all 117 lines; only re-recorded when the lines change |
| Amazon Bedrock + Lambda (`spotter-coach`) | "Analyse with AI": `POST /coach/analysis` takes one workout's numbers (reps, verdicts, depth, pace; never video) and a model writes a short coach report for the TV. Models are tried in order from `BEDROCK_MODELS`: Amazon Nova Lite or Claude Haiku 4.5 in a second account (its keys in Parameter Store), then Amazon Nova 2 Lite with the function's own role. Limits: 3 reports per move and 10 per pairing session, 150 a day in total, counted in one DynamoDB transaction. The TV draws its charts itself, so the AI only adds the coach's note | Under ₹0.05 ($0.0003) a report on Nova Lite; at most ~$0.75 a day even if abused |
| SSM Parameter Store | Keeps the second account's Bedrock keys encrypted, read only by `spotter-coach` | Free |
| CloudWatch log groups | Lambda logs, kept 7 days | Free tier |

Everything is deleted with the stack.

## Why each service

| Need | Service | Why this one |
|---|---|---|
| Phone and TV must talk in real time, both behind home routers, with no server of ours to run | **AWS AppSync Events** | Managed WebSocket pub/sub with channels: one channel per workout, the phone publishes reps and framing, the TV subscribes; also carries the WebRTC set-up so the video can go straight across the home Wi-Fi |
| A TV and a phone with no accounts must find each other | **API Gateway (HTTP API) + Lambda + DynamoDB** | A 4-digit code maps to a private channel for 2 hours, then DynamoDB's TTL deletes it. Nothing about the person is stored |
| Fire TV's own text-to-speech is silent for apps ([friction #10](https://github.com/Mallikarjuntr/repcast-tv-app/blob/main/docs/FRICTION.md#10)) | **Amazon Polly** (neural, Indian English) | Every coach line is recorded once, in CI, and bundled into the app: no voice call at workout time, no latency, works offline |
| A coach's read of the workout, in plain words | **Amazon Bedrock** (Amazon Nova) | Gets only the numbers (never video), works out nothing itself (the totals and comparisons are computed in code first) and writes the note in a fixed structure |
| No long-lived keys anywhere | **IAM + GitHub OIDC, CloudFormation (SAM), SSM Parameter Store** | Deploys only from this repo's `main`; the second account's Bedrock keys are encrypted and readable only by the coach function |
| Never a surprise bill | **AWS Budgets** + per-route throttles + report limits | A monthly budget alert, API throttles, and AI report limits |

## One-time setup

1. Deploy [`bootstrap/bootstrap.yaml`](bootstrap/bootstrap.yaml) once (CloudFormation console → Create stack → Upload). It creates the GitHub deploy role (usable only by this repo's `main` and `dev` branches), the SAM artifacts bucket and a monthly budget alert. Set `CreateOidcProvider=false` if the account already has GitHub's OIDC provider.
2. In this repo, add Actions variables from the stack outputs: `AWS_ROLE_ARN`, `SAM_ARTIFACTS_BUCKET`, and `AWS_REGION`.

## Workflows

| Workflow | Runs on | Does |
|---|---|---|
| Validate | push to `dev`, pull requests | typecheck, tests, `cfn-lint`, `sam build` |
| Deploy | push to `main`, manual | tests, `sam build`, `sam deploy`; prints stack outputs and budget status in the run summary |
| Destroy | manual (type `destroy`) | deletes the `spotter` stack so nothing keeps running |

## Local development

```bash
npm ci
npm run typecheck
npm test
```

## License

MIT
