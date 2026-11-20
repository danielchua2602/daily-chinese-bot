# Learnings

Everything we learned building this serverless Telegram bot, organized by topic.

### `.js` Extensions in Imports

TypeScript never rewrites import paths. `.js` is correct because imports describe the output, not the source:

| Extension | TypeScript           | Bundlers | Node.js ESM | Verdict         |
| --------- | -------------------- | -------- | ----------- | --------------- |
| None      | OK                   | OK       | Fails       | Legacy only     |
| `.ts`     | Errors               | OK       | Fails       | Deno only       |
| `.js`     | OK (resolves to .ts) | OK       | OK          | **Recommended** |

## AWS & Infrastructure

### SSM Parameter Store — String vs SecureString

Lambda environment variables **cannot use `ssm-secure` references**. CloudFormation rejects `{{resolve:ssm-secure:...}}` for `AWS::Lambda::Function` env vars because Lambda can't decrypt them at runtime — it just receives plaintext strings.

Additionally, `{{resolve:ssm:...}}` (plain syntax) **cannot read SecureString parameters**. CloudFormation enforces matching: SecureString requires `ssm-secure`, which Lambda doesn't support. It's a catch-22.

**Result:** Lambda env vars must use `{{resolve:ssm:...}}` with String-type parameters. Security comes from IAM (only your Lambdas can read the parameters), not KMS encryption at rest.

### CloudWatch Alarms — Key Concepts

- **Threshold:** The value the metric must reach to trigger the alarm (e.g., 1 error)
- **Evaluation Periods:** How many consecutive periods must breach before the alarm fires
- **`treatMissingData: NOT_BREACHING`:** "No data = no problem." Without this, quiet periods (no traffic at 3am) would trigger false alarms or leave the alarm in INSUFFICIENT_DATA state

| Config                   | Meaning                             | Use case                          |
| ------------------------ | ----------------------------------- | --------------------------------- |
| threshold: 1, periods: 1 | 1 error in 5 min -> alarm           | Personal bot, every error matters |
| threshold: 5, periods: 1 | 5+ errors in 5 min -> alarm         | Higher traffic, ignore blips      |
| threshold: 1, periods: 3 | Errors for 15 min straight -> alarm | Only sustained failures           |

### Free Tier Coverage

- **CloudWatch:** 10 alarms free (we use 3)
- **SNS:** 1,000 email notifications/month free, 1M API requests/month free
- **Lambda:** 1M requests/month free, 400K GB-seconds free
- **DynamoDB:** 25 GB storage, 25 WCU/RCU free (PAY_PER_REQUEST is separate pricing)

### Lambda Singleton Pattern

Create SDK clients at module level, not inside the handler:

```ts
// Module level: runs ONCE on cold start, reused across warm starts
const client = new DynamoDBClient({ region: "ap-southeast-1" });
const bot = new Bot(process.env.BOT_TOKEN!);

// Handler level: runs EVERY invocation
export const handler = async () => {
  /* uses client and bot */
};
```

Lambda keeps the process alive between invocations. Module-level code only runs on cold starts.

### CDK — `dotenv` for Deploy-Time Config

CDK runs as a regular Node.js process during `cdk synth`. To use `.env` values at synth time, import `dotenv/config` in the CDK app entry point:

```ts
// infra/bin/app.ts
import "dotenv/config"; // side-effect import, loads .env into process.env
import * as cdk from "aws-cdk-lib";
```

This lets you keep deploy-time config (like `ALARM_EMAIL`) in `.env` alongside runtime config.

---

## DynamoDB

### Single-Table Design

All entities share one table with structured keys:

| Entity       | PK          | SK                     | Purpose               |
| ------------ | ----------- | ---------------------- | --------------------- |
| User Profile | `USER#<id>` | `PROFILE`              | User settings         |
| Word         | `USER#<id>` | `WORD#<iso_timestamp>` | Sent vocabulary       |
| Session      | `USER#<id>` | `SESSION`              | Grammy session        |
| Conversation | `USER#<id>` | `CONVO`                | Multi-step flow state |

### GSI Patterns

- **GSI1 (Active Users):** `GSI1PK=ACTIVE` — scheduler queries only active users, avoids full table scan. Deactivated users have these attributes removed, automatically disappearing from the index.
- **GSI2 (Date Lookups):** `GSI2PK=USER#<id>, GSI2SK=YYYY-MM-DD` — enables "did user get words today?" checks and date-range queries for weekly recap.

### Efficient Query Patterns

- **Double-send prevention:** `Limit: 1` + `Select: COUNT` on GSI2 — checks existence without fetching data
- **Batch writes:** `BatchWriteCommand` for saving multiple words in one network call
- **Projection expressions:** `ProjectionExpression: "chinese"` fetches only needed fields

---

## Telegram Bot Development

### Webhook Security

Your API Gateway webhook URL is public. Without protection, anyone can send fake Telegram updates to it. Telegram supports a `secret_token` when registering the webhook — it sends it as `X-Telegram-Bot-Api-Secret-Token` on every update. Grammy's `webhookCallback` validates it automatically:

```ts
export const handler = webhookCallback(bot, "aws-lambda-async", {
  secretToken: process.env.WEBHOOK_SECRET,
});
```

Register the webhook with: `setWebhook?url=<URL>&secret_token=<SECRET>`

### User Allowlist

Telegram doesn't have a built-in bot access control. Implement it as middleware that checks `ctx.from?.id` before any processing. Silently ignore unauthorized users (replying "not authorized" confirms the bot is active and invites more spam).

Parse allowed IDs from an env var at cold start for O(1) lookup:

```ts
const allowedUsers = new Set((process.env.ALLOWED_USERS ?? "").split(",").filter(Boolean).map(Number));
```

### Bot Username

BotFather doesn't allow changing a bot's username after creation — you'd have to create a new bot. The **display name** (what users see in chat) can be changed freely.

### Group Chat Control

Disable group joins via BotFather: `/mybots` -> Bot Settings -> Allow Groups -> Off. This is a Telegram-level setting, no code needed.

### `setMyCommands`

Registers the command menu users see when pressing `/`. This is display-only — it doesn't restrict which commands work. Call it once via the Telegram API.

### Grammy Middleware Order

Order matters. Middleware runs top to bottom, and `next()` passes control to the next handler:

1. **Allowlist** — blocks unauthorized users (no `next()` = stops chain)
2. **Conversations plugin** — intercepts updates for active multi-step flows
3. **Conversation builders** — registers conversation handlers
4. **Command handlers** — routes `/commands`
5. **Catch-all** — handles unknown commands

---

## Encryption

### AES-256-GCM

- **AES-256:** Symmetric encryption (same key encrypts and decrypts)
- **GCM:** Authenticated mode — encrypts AND detects tampering. If ciphertext is modified in DynamoDB, decryption fails.
- **Random IV per encryption:** Identical plaintexts produce different ciphertexts
- **Stored format:** `iv:authTag:ciphertext` (all hex-encoded)
- **Why not AES-CBC?** No built-in authentication — vulnerable to padding oracle attacks
- **Why not ChaCha20?** AES-GCM has hardware acceleration on Lambda's x86 CPUs

---

## Architecture Patterns

### Strategy Pattern (AI Providers)

All providers implement the same `AIProvider` interface. The bot depends only on the interface, not concrete implementations. Swap providers without changing calling code.

### Centralized Retry Logic

Retry logic lives in the word-generator service, not in individual AI adapters. Avoids duplicating retry code across three providers.

- **Fixed 1s delay** (not exponential backoff) — failures are bad AI output, not rate limits
- **Configurable max retries** via `WORD_GEN_MAX_RETRIES` env var

### Error Classification

Each AI adapter classifies SDK-specific errors into a unified `ProviderError`:

- **Retryable:** Bad AI output, transient network issue — retry
- **Non-retryable:** Bad API key, quota exceeded — stop immediately, notify user

### Concurrency Control

The scheduler uses `p-limit(5)` to cap concurrent AI API calls and `Promise.allSettled()` so one user's failure doesn't block others.

### Save Before Send

Word generation saves to DynamoDB **before** sending to Telegram. If the Telegram send fails, at least the generated words exist in the database for retry.

---

## Date & Time

### ISO Week Number Algorithm

Finds the nearest Thursday (ISO weeks start on Monday, week 1 contains the year's first Thursday), then counts weeks from Jan 1. This handles edge cases like Dec 31 being in week 1 of the next year.

### Timezone Handling with Intl API

- **IANA timezone strings** handle DST automatically (numeric offsets like "+8" don't)
- `toLocaleDateString('en-CA', { timeZone })` returns `YYYY-MM-DD` (Canada uses ISO 8601)
- City picker UX avoids users typing IANA strings like "America/New_York"

### Date Parsing Gotcha

`new Date("2026-03-17")` is parsed as **UTC midnight**. In negative-offset timezones, this shifts the date back by one day. Adding `T00:00:00` forces parsing as local time:

```ts
new Date("2026-03-17T00:00:00"); // local midnight, correct date
```

---

## Grammy Conversations (v2)

### Replay Model

On every Telegram update, the conversation function **re-runs from the start**. The plugin replays prior I/O transparently, skipping past already-completed steps. This means:

- Side effects (DB writes, encryption) must be wrapped in `conversation.external()` to ensure single execution
- State persists in DynamoDB via a storage adapter with optimistic concurrency

### Telegram Message Limits

Telegram rejects messages over **4096 characters**. The formatter splits long messages on paragraph breaks, then line breaks, then hard cuts — never truncating content.
