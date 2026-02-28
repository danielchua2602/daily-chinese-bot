# Telegram Daily Chinese Words Bot — Implementation Plan

## Architecture Overview

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Telegram    │◄───►│  API Gateway     │◄───►│  AI Provider│
│  Users       │     │  (webhook)       │     │  (Claude,   │
└─────────────┘     │       ↓          │     │   Gemini,   │
                    │  Lambda (bot)     │     │   OpenAI)   │
                    └──────────────────┘     └─────────────┘
                              ↕
                    ┌──────────────────┐
                    │  DynamoDB        │
                    │  (single table)  │
                    └──────────────────┘
                              ↑
                    ┌──────────────────┐
                    │  EventBridge     │
                    │  (every minute)  │
                    │       ↓          │
                    │  Lambda          │
                    │  (scheduler)     │
                    └──────────────────┘
```

### Two Lambda Functions

1. **Bot Lambda** — triggered by API Gateway (Telegram webhook). Handles all commands and onboarding conversations.
2. **Scheduler Lambda** — triggered by EventBridge every minute. Finds due users, generates and sends words + weekly recaps.

---

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Telegram SDK:** `grammy` (webhook mode via `webhookCallback`)
- **Database:** DynamoDB (on-demand capacity, single-table design)
- **Scheduler:** EventBridge rule (every minute) → Lambda
- **AI SDKs:** `@anthropic-ai/sdk`, `@google/generative-ai`, `openai`
- **Validation:** `zod` (AI response validation)
- **Infrastructure:** AWS CDK (TypeScript — same language as the bot)
- **Logging:** CloudWatch Logs (built-in with Lambda, structured JSON via pino)

---

## DynamoDB Single-Table Design

One table (`ChineseBot`) holds all entities, distinguished by PK/SK key patterns.

### Key Schema

| PK | SK | Entity | Attributes |
|---|---|---|---|
| `USER#<telegram_id>` | `PROFILE` | User profile | username, ai_provider, api_key (encrypted), hsk_level, timezone, send_hour, send_minute, daily_word_count, recap_day (default: `sunday`), recap_hour, recap_minute, is_active, created_at |
| `USER#<telegram_id>` | `WORD#<sent_at_iso>` | Sent word | chinese, pinyin, english, example_sentence, example_pinyin, example_english, local_date |
| `USER#<telegram_id>` | `SESSION` | Grammy session | conversation state (used by custom DynamoDB adapter) |

### Global Secondary Indexes

**GSI1: `GSI1PK` / `GSI1SK`** — for scheduler lookups
| GSI1PK | GSI1SK | Purpose |
|---|---|---|
| `ACTIVE` | `USER#<telegram_id>` | Find all active users (scheduler scans this GSI) |

- When `is_active = true`, write an item with GSI1PK=`ACTIVE`. When deactivated, delete the GSI1 projection (or set GSI1PK to `INACTIVE`).

**GSI2: `GSI2PK` / `GSI2SK`** — for double-send prevention and recap
| GSI2PK | GSI2SK | Purpose |
|---|---|---|
| `USER#<telegram_id>` | `<YYYY-MM-DD>` | Query words by user + local date |

- Only Word entities project into this GSI. Used to check "has this user received words today?" and "get all words from the last 7 days."

### Access Patterns

| Access Pattern | Query |
|---|---|
| Get user profile | PK=`USER#123`, SK=`PROFILE` |
| Get user's recent words | PK=`USER#123`, SK begins_with `WORD#`, ScanIndexForward=false, Limit=200 |
| Check today's words sent | GSI2: PK=`USER#123`, SK=`2024-03-01` |
| Get week's words for recap | GSI2: PK=`USER#123`, SK between `2024-02-24` and `2024-03-02` |
| Get all active users (scheduler) | GSI1: PK=`ACTIVE` |
| Get/set Grammy session | PK=`USER#123`, SK=`SESSION` |

---

## Scheduler Design (EventBridge + Lambda)

EventBridge rule fires every minute → invokes Scheduler Lambda.

```typescript
// scheduler handler
export const handler = async () => {
  const now = new Date();

  // Scan active users (via GSI1)
  const activeUsers = await getActiveUsers();

  // Filter to users whose local time matches their send_hour:send_minute
  const dueUsers = activeUsers.filter(user => {
    const userNow = new Date(now.toLocaleString('en-US', { timeZone: user.timezone }));
    return userNow.getHours() === user.send_hour
        && userNow.getMinutes() === user.send_minute;
  });

  // For each due user, check double-send and generate words
  for (const user of dueUsers) {
    const userLocalDate = now.toLocaleDateString('en-CA', { timeZone: user.timezone });
    const alreadySent = await hasWordsForDate(user.telegram_id, userLocalDate);
    if (alreadySent) continue;

    try {
      await generateAndSendWords(user, userLocalDate);
    } catch (err) {
      await handleSendError(user, err); // 403 → deactivate, 401 → notify
    }
  }

  // Check for recap-due users (same pattern, matching recap_day + recap_hour:recap_minute)
  const recapDueUsers = activeUsers.filter(user => {
    const userNow = new Date(now.toLocaleString('en-US', { timeZone: user.timezone }));
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return dayNames[userNow.getDay()] === user.recap_day
        && userNow.getHours() === user.recap_hour
        && userNow.getMinutes() === user.recap_minute;
  });

  for (const user of recapDueUsers) {
    await generateAndSendRecap(user);
  }
};
```

**Key design decisions:**
- Timezone conversion in Node.js using `Intl` API (handles DST correctly)
- Double-send prevention uses user-local date stored alongside words
- No mutex needed — Lambda executions are isolated (unlike cron in a long-running process)
- Concurrency: process users with `p-limit(5)` to respect AI API rate limits

---

## Grammy Webhook Setup

Grammy supports Lambda via `webhookCallback`:

```typescript
// bot Lambda handler
import { Bot, webhookCallback } from 'grammy';

const bot = new Bot(process.env.BOT_TOKEN!);
// ... register commands, conversations ...

export const handler = webhookCallback(bot, 'aws-lambda-async');
```

### Session Storage for Conversations

Grammy conversations need persistent session storage (Lambda is stateless). Use a custom adapter that stores sessions in the single table with PK=`USER#<id>`, SK=`SESSION`:

```typescript
// Custom storage adapter using our single table
const sessionStorage = {
  read: (key: string) => getItem({ PK: `USER#${key}`, SK: 'SESSION' }),
  write: (key: string, value: any) => putItem({ PK: `USER#${key}`, SK: 'SESSION', ...value }),
  delete: (key: string) => deleteItem({ PK: `USER#${key}`, SK: 'SESSION' }),
};

bot.use(session({ initial: () => ({}), storage: sessionStorage }));
```

No extra table needed — sessions live alongside user data in the same table.

---

## Bot Commands

```
/start     → Welcome + begin onboarding
/setup     → Re-run setup (provider, key, level)
/settime   → Pick daily delivery time
/setrecap  → Pick weekly recap day and time
/today     → Get today's words on demand
/settings  → View/change all settings
/stop      → Pause daily words
/resume    → Resume daily words
/help      → List all available commands
```

### Onboarding Flow (after `/start`)

1. Choose AI Provider → `[Anthropic] [Gemini] [OpenAI]`
2. Enter API key → bot deletes message after reading, encrypts with AES-256-GCM
3. Bot validates key with a test request
4. Choose HSK level → `[HSK 1] [HSK 2] [HSK 3] [HSK 4] [HSK 5] [HSK 6]`
5. Choose timezone + send time (same as `/settime`)
6. Choose recap day + time (same as `/setrecap`, defaults to Sunday at send time)
7. Confirmation + first words sent immediately

### `/settime` Flow

1. Bot asks: "What timezone are you in?" → Inline keyboard with common options + "Other" that accepts IANA string (validated via `Intl.supportedValuesOf('timeZone')`)
2. Bot asks: "What time should I send your daily words?" → Inline keyboard grid:
```
[6:00 AM] [7:00 AM] [8:00 AM] [9:00 AM]
[10:00 AM] [12:00 PM] [6:00 PM] [9:00 PM]
[Custom time]
```
3. If "Custom time" → user types `HH:MM` (24h format), bot parses and confirms
4. Bot confirms: "Got it! You'll receive words daily at 8:30 AM (Asia/Tokyo)"

### `/setrecap` Flow

1. Bot asks: "Which day should I send your weekly recap?" → Inline keyboard:
```
[Monday] [Tuesday] [Wednesday] [Thursday]
[Friday] [Saturday] [Sunday]
```
2. Bot asks: "What time?" → Same time picker as `/settime`
3. Bot confirms: "Got it! Weekly recap every Sunday at 8:00 PM (Asia/Tokyo)"

---

## AI Provider Interface

```typescript
// ai/provider.ts
interface WordResult {
  chinese: string;
  pinyin: string;
  english: string;
  example_sentence: string;
  example_pinyin: string;
  example_english: string;
}

interface AIProvider {
  generateWords(params: {
    count: number;
    hskLevel: number;
    excludeWords: string[];
  }): Promise<WordResult[]>;

  validateKey(): Promise<boolean>;
}
```

Each adapter (anthropic.ts, gemini.ts, openai.ts) implements this interface using the respective SDK.

### Validation Pipeline

1. Strip markdown code fences before `JSON.parse`
2. Validate with `zod` schema: all fields present, non-empty, `chinese` contains CJK chars (`/[\u4e00-\u9fff]/`)
3. Check word count matches request
4. Filter out words from exclude list (capped at ~200 most recent)
5. Retry on failure (max 2 retries with exponential backoff)

### Error Handling

- 401/403 from AI → message user ("Your API key appears invalid. Use /setup to update it."), set `is_active = 0`
- 403 from Telegram (user blocked bot) → set `is_active = 0`
- 429 (rate limit) → exponential backoff

---

## Message Formats

### Daily Words

```
📚 Daily Chinese Words — March 3

1. 你好 (nǐ hǎo) — hello
   💬 你好，我是小明。
      Nǐ hǎo, wǒ shì Xiǎo Míng.
      Hello, I am Xiao Ming.

2. 谢谢 (xiè xie) — thank you
   💬 谢谢你的帮助。
      Xiè xie nǐ de bāng zhù.
      Thank you for your help.

3. 再见 (zài jiàn) — goodbye
   💬 明天再见！
      Míng tiān zài jiàn!
      See you tomorrow!
```

### Weekly Recap (automatic)

```
📖 Week 9 Recap — 21 words learned!

Mon: 你好 (nǐ hǎo), 谢谢 (xiè xie), 再见 (zài jiàn)
Tue: 吃饭 (chī fàn), 喝水 (hē shuǐ), 睡觉 (shuì jiào)
Wed: 学习 (xué xí), 工作 (gōng zuò), 休息 (xiū xi)
...

Keep it up! 💪
```

Messages exceeding ~4000 characters are split into multiple sends.

---

## AWS Infrastructure (CDK in TypeScript)

```typescript
// infra/lib/chinese-bot-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export class ChineseBotStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string) {
    super(scope, id);

    // Single DynamoDB table for all entities
    const table = new dynamodb.Table(this, 'ChineseBot', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoveryEnabled: true,
    });

    // GSI1: scheduler finds active users
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // GSI2: double-send check + recap by user+date
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // Bot Lambda (webhook handler)
    const botFn = new lambda.NodejsFunction(this, 'BotHandler', {
      entry: 'src/handlers/bot.ts',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    // Scheduler Lambda (every minute)
    const schedulerFn = new lambda.NodejsFunction(this, 'SchedulerHandler', {
      entry: 'src/handlers/scheduler.ts',
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
    });

    // API Gateway for Telegram webhook
    const api = new apigateway.RestApi(this, 'BotApi');
    api.root.addResource('webhook').addMethod(
      'POST', new apigateway.LambdaIntegration(botFn)
    );

    // EventBridge rule: fire scheduler every minute
    new events.Rule(this, 'ScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(schedulerFn)],
    });

    // Grant DynamoDB access (single table — one grant covers everything)
    table.grantReadWriteData(botFn);
    table.grantReadWriteData(schedulerFn);
  }
}
```

---

## Cost Estimate (Serverless)

| Resource | Monthly Cost (small scale, <100 users) |
|---|---|
| Lambda (bot + scheduler) | ~$0.50 (free tier: 1M requests) |
| API Gateway | ~$0.10 (free tier: 1M requests) |
| DynamoDB (on-demand) | ~$0.25 (free tier: 25 WCU/RCU) |
| EventBridge | ~$0 (free tier covers it) |
| CloudWatch Logs | ~$0.10 |
| **Total** | **~$1 — $2/mo** (mostly free-tier covered) |

Post free-tier or at ~1000 users: ~$5-10/mo. Scales linearly.

---

## Project File Structure

```
learn-chinese-telegram/
├── src/
│   ├── handlers/
│   │   ├── bot.ts               # Bot Lambda entry point (webhook)
│   │   └── scheduler.ts         # Scheduler Lambda entry point
│   ├── bot/
│   │   ├── commands.ts          # All command handlers
│   │   ├── conversations.ts     # Onboarding + settime + setrecap flows
│   │   └── keyboards.ts         # Inline keyboard builders
│   ├── ai/
│   │   ├── provider.ts          # Unified interface + factory
│   │   ├── anthropic.ts         # Anthropic adapter
│   │   ├── gemini.ts            # Gemini adapter
│   │   └── openai.ts            # OpenAI adapter
│   ├── services/
│   │   ├── word-generator.ts    # Prompt construction + validation + dedup
│   │   ├── send-words.ts        # Generate + format + send to user
│   │   └── recap.ts             # Weekly recap builder (automatic)
│   ├── db/
│   │   ├── client.ts            # DynamoDB document client singleton
│   │   ├── keys.ts              # PK/SK key builders (USER#, WORD#, SESSION)
│   │   ├── users.ts             # User profile CRUD + active user queries (GSI1)
│   │   ├── words.ts             # Word storage + date queries (GSI2)
│   │   └── sessions.ts          # Grammy session storage adapter
│   └── utils/
│       ├── crypto.ts            # AES-256-GCM API key encryption
│       ├── format.ts            # Telegram message formatters + splitting
│       ├── timezone.ts          # Timezone validation + conversion
│       └── validation.ts        # Zod schemas for AI responses
├── infra/
│   ├── bin/
│   │   └── app.ts               # CDK app entry point
│   └── lib/
│       └── chinese-bot-stack.ts  # Stack definition (Lambda, DynamoDB, API GW, EventBridge)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Security Notes

- Encrypt API keys with AES-256-GCM using `ENCRYPTION_KEY` from Lambda env vars (or AWS Secrets Manager)
- Immediately delete user messages containing API keys
- Never log API keys
- API Gateway: validate Telegram webhook requests via bot token secret
- DynamoDB: IAM roles scoped to the single table only
- Lambda env vars encrypted at rest by default

---

## Implementation Phases

Implement these phases sequentially. Complete and test each phase before moving to the next.

### Phase 1 — Scaffolding + Infrastructure

- Initialize Node.js + TypeScript project
- Install deps: `grammy`, `@grammyjs/conversations`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `zod`, `pino`, `dotenv`, `@anthropic-ai/sdk`, `@google/generative-ai`, `openai`, `p-limit`
- `tsconfig.json` with strict mode
- Set up CDK project in `infra/` — define both Lambda functions, DynamoDB table with GSIs, API Gateway, EventBridge rule
- `cdk deploy` to create all infrastructure
- Implement `crypto.ts` (AES-256-GCM) — encryption from day one
- Implement DynamoDB client + `keys.ts` (PK/SK builders) + user/word CRUD operations
- Implement `timezone.ts` with IANA validation (`Intl.supportedValuesOf('timeZone')`)
- Create bot Lambda handler with Grammy webhook + `/start` + `/help`
- Deploy to AWS, register webhook with Telegram
- **Test:** bot responds to `/start` in Telegram

### Phase 2 — Onboarding + Settings

- Implement Grammy conversations plugin with custom DynamoDB session storage
- Build onboarding flow: provider → encrypted API key → HSK level → timezone (validated) → send time → recap day/time
- `/setup` to re-run onboarding (preserves word history, overwrites key)
- `/settime`, `/setrecap`, `/settings`, `/stop`, `/resume`
- Input validation: HSK 1-6, hour 0-23, minute 0-59, word count 1-10, valid IANA timezone, valid recap day
- **Test:** complete onboarding, verify encrypted key in DynamoDB, change all settings

### Phase 3 — AI Providers + Word Generation

- Unified `AIProvider` interface with factory function
- Anthropic, Gemini, OpenAI adapters
- Word generation with zod validation pipeline (JSON parsing, schema check, CJK validation, exclude-list enforcement, count check, retries with exponential backoff)
- `validateKey()` per provider (used during onboarding)
- Exclude list capped at ~200 most recent words (send only Chinese characters to minimize tokens)
- Message formatting with length splitting (>4000 char guard)
- `/today` command
- **Test:** `/today` returns correctly formatted words with each AI provider

### Phase 4 — Daily Scheduler

- Scheduler Lambda handler with EventBridge trigger
- Timezone conversion in Node.js (Intl API, DST-safe)
- Double-send prevention using user-local date (stored in `local_date` attribute, queried via GSI2)
- Concurrency limiter (`p-limit(5)`) for AI API calls
- Error handling: blocked users (Telegram 403 → deactivate), expired API keys (AI 401/403 → notify user + deactivate)
- Per-user structured logging via pino
- **Test:** set send time to 1 min from now, verify delivery. Test with various timezones.

### Phase 5 — Automatic Weekly Recap

- Recap service: query words from last 7 days via GSI2, group by day
- Format recap message (day-by-day word list with pinyin and English)
- Message splitting if recap exceeds Telegram's 4096 char limit
- Add recap check to scheduler: for each active user, check if today matches their `recap_day` and current time matches `recap_hour:recap_minute`
- Default: recap on Sunday at the same time as daily words
- **Test:** set recap to current day + 1 minute from now, verify recap sends automatically

### Phase 6 — Hardening + Production Readiness

- API Gateway webhook security (validate Telegram secret token)
- CloudWatch alarms (Lambda errors, DynamoDB throttling)
- Deployment documentation
- `.env.example` with all required variables
- DynamoDB point-in-time recovery (PITR) — automatic backups already enabled in CDK
- End-to-end testing: onboarding → daily delivery → weekly recap
- **Test:** full user journey over multiple days
