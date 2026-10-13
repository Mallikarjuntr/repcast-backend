# Spotter backend

AWS infrastructure and serverless functions for [Spotter](https://github.com/Mallikarjuntr/spotter-tv-app), defined as a CloudFormation (AWS SAM) stack and deployed by GitHub Actions.

- **AppSync Events** — live link between the camera device and the TV
- **API Gateway + Lambda** — AI coach (Amazon Bedrock), purchase checks, free-session quota, workout history
- **DynamoDB** — users, sessions, history

Deployment uses GitHub OIDC — no long-lived AWS keys are stored anywhere. Setup instructions are coming soon.

## License

MIT
