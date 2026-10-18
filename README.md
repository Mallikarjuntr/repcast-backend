# Spotter backend

AWS infrastructure and serverless functions for [Spotter](https://github.com/Mallikarjuntr/spotter-tv-app), defined as CloudFormation (AWS SAM) and deployed by GitHub Actions. No long-lived AWS keys are stored anywhere: Actions signs in to AWS through GitHub OIDC.

## What it creates

| Resource | Purpose | Cost notes |
|---|---|---|
| AppSync Events API (`spotter-events`) | Live link: the camera device publishes pose events, the TV subscribes (one channel per session) | ~$1 per million messages |
| HTTP API + Lambda (`spotter-api`) | `GET /health`, `POST /sessions` (new 6-digit pairing code), `GET /sessions/{code}` | Free tier; throttled to 10 req/s |
| DynamoDB (`spotter-data`) | Sessions (auto-expire after 2 hours via TTL), later workout history | Provisioned 2/2, inside the always-free tier |
| Amazon Polly + Lambda (`spotter-voice`) | Records the coach's voice: every line the TV says (counts, form cues, rest, finish) as an MP3 with the neural voice *Kajal*. The Deploy workflow runs it when `voice/phrases.json` changes and attaches the clips to the run; the TV app bundles them, because Fire TV's own text-to-speech is silent for apps. No public route | About $0.06 for all 117 lines; only re-recorded when the lines change |
| Amazon Bedrock + Lambda (`spotter-coach`) | "Analyse with AI": `POST /coach/analysis` takes one workout's numbers (reps, verdicts, depth, pace; never video) and a model writes a short coach report for the TV. Models are tried in order from `BEDROCK_MODELS` (Amazon Nova 2 Lite via Converse with the function's own role; Claude via a second account's keys in Parameter Store). Each pairing session may ask for 10 reports | Under ₹0.50 ($0.005) a report with Nova 2 Lite |
| SSM Parameter Store | Keeps the second account's Bedrock keys encrypted, read only by `spotter-coach` | Free |
| CloudWatch log groups | Lambda logs, kept 7 days | Free tier |

Everything is deleted with the stack.

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
