# AWS Services Documentation — IIT Project

> **Project:** IIT Careers Platform  
> **AWS Account ID:** `642627578700`  
> **Primary Region:** `eu-central-1`  
> **S3 / SQS Region:** `me-central-1`  
> **Environments:** `development` · `production`  
> **Architecture:** 8 Serverless Microservices on AWS Lambda + API Gateway

---

## Tree Map — All AWS Services

```
IIT Project (AWS Infrastructure)
│
├── 🖥️  COMPUTE
│   └── AWS Lambda
│       ├── admin-service          → admin-services-iit (prod)
│       ├── feed-services          → feed-services-iit-prod
│       ├── firebase-service       → firebase-service-iit-prod
│       ├── job-service            → job-services-iit-prod
│       ├── linkedin-pdf           → linkedin-services-iit-prod
│       ├── notification-service   → notify-service-iit-prod
│       ├── page-service           → page-content-iit-prod
│       └── user-services          → user-services-iit-prod
│
├── 🌐  NETWORKING & API
│   ├── AWS API Gateway
│   │   ├── admin-v1       → api.iit.twe.co/admin-v1
│   │   ├── user-v1        → api.iit.twe.co/user-v1
│   │   ├── feed-v1        → api.iit.twe.co/feed-v1
│   │   ├── notification-v1→ api.iit.twe.co/notification-v1
│   │   ├── page-v1        → api.iit.twe.co/page-v1
│   │   ├── firebase-v1    → api.iit.twe.co/firebase-v1
│   │   ├── pdf-v1         → api.iit.twe.co/pdf-v1
│   │   └── job-v1         → api.iit.twe.co/job-v1
│   │
│   ├── AWS Route 53
│   │   ├── api.iit.twe.co          (production)
│   │   └── devapi.iit.twe.co       (development)
│   │
│   └── AWS CloudFront
│       ├── Distribution: E28C4RQHF7WJU9  (production)
│       ├── Distribution: EMJP8JYPDXXX4   (development)
│       └── Origin: meassets.iit.twe.co
│
├── 🗄️  STORAGE
│   └── AWS S3
│       ├── [PROD] meassets.iit.co          → main assets
│       ├── [PROD] meupload.iit.co          → video uploads
│       ├── [PROD] me-iit-prod-bulk-assets  → bulk operations
│       ├── [PROD] me-iit-optimize-media-prod → optimized media
│       ├── [PROD] video-recognition-iit-prod → video processing
│       ├── [DEV]  medevassets.iit.co       → dev assets
│       ├── [DEV]  medevupload.iit.co       → dev video uploads
│       ├── [DEV]  me-iit-dev-bulk-assets   → dev bulk ops
│       ├── [DEV]  me-iit-optimize-media-dev→ dev optimized media
│       └── [DEV]  video-recognition-iit-dev→ dev video processing
│
├── 📨  MESSAGING
│   └── AWS SQS
│       └── dev-post-invalid-content
│           └── https://sqs.me-central-1.amazonaws.com/642627578700/dev-post-invalid-content
│
├── ⏰  SCHEDULING
│   └── AWS EventBridge (CloudWatch Events)
│       ├── bulk-page-create-cron          → */2 * * * ? *
│       ├── event-reminder-cron            → 30 10 * * ? *
│       ├── challenge-remember-mail-cron   → */1 * * * ? *
│       ├── update-profile-remember-cron   → 30 10 * * ? *
│       └── bulkAlumniUploadCron           → */2 * * * ? *
│
├── 🤖  AI / ML
│   └── AWS Rekognition
│       └── Image moderation labels (content flagging)
│
├── 🔧  INFRASTRUCTURE
│   ├── AWS Lambda Layers
│   │   ├── user-service      (v4–v5)
│   │   ├── feed-service      (v1)
│   │   ├── firebase-service  (v1)
│   │   ├── job-service       (v1)
│   │   ├── page-service      (v1)
│   │   ├── notification-service (v1)
│   │   ├── pdf-service       (v1)
│   │   ├── puppeteer-core    (v1)
│   │   ├── chromium          (v1)
│   │   ├── mailchimp         (v1)
│   │   └── aws-sdk           (v2)
│   │
│   ├── AWS IAM
│   │   └── Profile: iit  (used for all deployments)
│   │
│   └── AWS CloudWatch
│       └── Lambda execution logs (all functions)
│
└── ⚠️  INACTIVE / DISABLED
    ├── AWS Comprehend   → layer exists, commented out in feed-services
    └── AWS ElastiCache  → Redis configured, REDIS_ENABLE=false
```

---

## 1. AWS Lambda

**Purpose:** Core compute layer — every microservice runs as a Lambda function.

| Service | Lambda Function Name | Runtime | Timeout | Region |
|---|---|---|---|---|
| admin-service | `admin-services-iit` | Node.js 20.x | 30s | eu-central-1 |
| feed-services | `feed-services-iit-prod` | Node.js 20.x | 30s | eu-central-1 |
| firebase-service | `firebase-service-iit-prod` | Node.js 16.x | 30s | eu-central-1 |
| job-service | `job-services-iit-prod` | Node.js 20.x | 30s | eu-central-1 |
| linkedin-pdf | `linkedin-services-iit-prod` | Node.js 20.x | 30s | eu-central-1 |
| notification-service | `notify-service-iit-prod` | Node.js 16.x | 30s | eu-central-1 |
| page-service | `page-content-iit-prod` | Node.js 20.x | 30s | eu-central-1 |
| user-services | `user-services-iit-prod` | Node.js 20.x | 30s | eu-central-1 |

**Handler pattern (all services):**
```js
// serverless.yml
functions:
  app:
    handler: app.server
    events:
      - http:
          path: /
          method: ANY
      - http:
          path: /{proxy+}
          method: ANY
```

**Deployment command:**
```bash
sls deploy --aws-profile iit
```

**Log tailing:**
```bash
sls logs -f app -t --aws-profile iit
```

---

## 2. AWS API Gateway

**Purpose:** HTTP entry point for all 8 microservices. Each service gets its own base path on the shared domain.

| Service | Base Path | Domain (Prod) | Domain (Dev) |
|---|---|---|---|
| admin-service | `/admin-v1` | `api.iit.twe.co/admin-v1` | `devapi.iit.twe.co/admin-v1` |
| user-services | `/user-v1` | `api.iit.twe.co/user-v1` | `devapi.iit.twe.co/user-v1` |
| feed-services | `/feed-v1` | `api.iit.twe.co/feed-v1` | `devapi.iit.twe.co/feed-v1` |
| notification-service | `/notification-v1` | `api.iit.twe.co/notification-v1` | `devapi.iit.twe.co/notification-v1` |
| page-service | `/page-v1` | `api.iit.twe.co/page-v1` | `devapi.iit.twe.co/page-v1` |
| firebase-service | `/firebase-v1` | `api.iit.twe.co/firebase-v1` | `devapi.iit.twe.co/firebase-v1` |
| linkedin-pdf | `/pdf-v1` | `api.iit.twe.co/pdf-v1` | `devapi.iit.twe.co/pdf-v1` |
| job-service | `/job-v1` | `api.iit.twe.co/job-v1` | `devapi.iit.twe.co/job-v1` |

**CORS Configuration (all endpoints):**
```yaml
cors:
  origin: "*"
  headers:
    - Content-Type
    - Authorization
    - language
```

**Binary media types** (page-service, linkedin-pdf):
- `application/pdf`
- `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `application/octet-stream`

---

## 3. AWS S3 (Simple Storage Service)

**Region:** `me-central-1`  
**SDK:** `@aws-sdk/client-s3`  
**Files:** `*/utilities/upload.utilities.js`, `page-service/services/meta/meta.service.js`

### Buckets

| Bucket Name | Environment | Purpose |
|---|---|---|
| `meassets.iit.co` | Production | Main assets (images, files, meta JSON) |
| `meupload.iit.co` | Production | Raw video uploads |
| `me-iit-prod-bulk-assets` | Production | Bulk alumni/user CSV uploads |
| `me-iit-optimize-media-prod` | Production | Optimized/compressed media |
| `video-recognition-iit-prod` | Production | Video processing pipeline |
| `medevassets.iit.co` | Development | Dev main assets |
| `medevupload.iit.co` | Development | Dev video uploads |
| `me-iit-dev-bulk-assets` | Development | Dev bulk uploads |
| `me-iit-optimize-media-dev` | Development | Dev optimized media |
| `video-recognition-iit-dev` | Development | Dev video processing |

### Folder Structure (main bucket)

```
meassets.iit.co/
├── temp/               ← temporary upload staging area
├── category/           ← category images
├── interestsImages/    ← interest/tag images
├── challenge/          ← challenge media
├── report/             ← report files
├── meta/               ← JSON metadata files (type.json)
│   ├── skills.json
│   ├── interests.json
│   └── ...
├── linkedin/
│   └── pdf/            ← generated LinkedIn PDFs
└── logo/               ← app logos
```

### S3 Operations Used

```js
// upload.utilities.js — admin-service & job-service
const {
  S3Client,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

// Move file from temp/ to final folder
upload.moveFile(folder, image);

// Upload file directly
upload.uploadFile(folder, file);

// Get presigned URL for direct browser upload
upload.getPresignedUrl(key);

// Delete a file
upload.deleteFile(key);
```

### Credentials

```
ACCESS_KEY=AKIAZLH4WVNGED753K5N
SECRET_ACCESS_KEY=<stored in secret.json>
S3_REGION=me-central-1
```

---

## 4. AWS CloudFront

**Purpose:** CDN for serving static assets and meta JSON files. Cache invalidation is triggered after meta data updates.

**SDK:** `@aws-sdk/client-cloudfront`  
**File:** `page-service/controllers/v1/meta/meta.controller.js`

| Environment | Distribution ID | Origin URL |
|---|---|---|
| Production | `E28C4RQHF7WJU9` | `meassets.iit.twe.co` |
| Development | `EMJP8JYPDXXX4` | `medevassets.iit.twe.co` |

### How It's Used

After any meta JSON file is updated in S3, the controller immediately invalidates the CloudFront cache so users get fresh data:

```js
const { CloudFrontClient, CreateInvalidationCommand } = require("@aws-sdk/client-cloudfront");

const client = new CloudFrontClient({
  credentials: { accessKeyId: config.ACCESS_KEY, secretAccessKey: config.SECRET_ACCESS_KEY },
  region: config.REGION,
});

const command = new CreateInvalidationCommand({
  DistributionId: config.DISTRIBUTION_ID,
  InvalidationBatch: {
    CallerReference: String(new Date().getTime()),
    Paths: { Quantity: 1, Items: [`/meta/${type}.json`] },
  },
});

await client.send(command);
```

**Invalidation paths:** `/meta/{type}.json` (e.g., `/meta/skills.json`, `/meta/interests.json`)

---

## 5. AWS SQS (Simple Queue Service)

**Purpose:** Async content moderation pipeline. When a feed post is created, a message is sent to SQS. A separate Lambda consumer processes it for invalid/flagged content.

**Region:** `me-central-1`  
**Files:** `admin-service/controllers/v1/feed/feed.controller.js`, `feed-services/controllers/v1/cron/cronController.js`

### Queue Details

| Property | Value |
|---|---|
| Queue Name | `dev-post-invalid-content` |
| Queue URL | `https://sqs.me-central-1.amazonaws.com/642627578700/dev-post-invalid-content` |
| Account ID | `642627578700` |

### Message Flow

```
User creates post
      │
      ▼
admin-service Lambda
  → sends SQS message { feedId, userId, description }
      │
      ▼
SQS Queue: dev-post-invalid-content
      │
      ▼
feed-services Lambda (SQS trigger)
  → cronController.invalidContentSqs
  → checks content against Rekognition moderation rules
  → checks URLs for safety
  → flags/blocks post if invalid
  → sends notification to user if flagged
```

### Producer (admin-service)

```js
// feed.controller.js
const SQS_URL = config.INVALID_CONTENT_SQS;
// Sends: { feedId, userId, description }
```

### Consumer (feed-services)

```js
// cronController.js — triggered by SQS event
module.exports.invalidContentSqs = async (req, res) => {
  const { body } = req.Records[0];
  const { feedId, userId, description } = JSON.parse(body);
  // runs moderation checks...
};
```

---

## 6. AWS EventBridge (Scheduled Cron Jobs)

**Purpose:** Scheduled Lambda invocations for background tasks.  
**Files:** `serverless.yml` in job-service, page-service, user-services

| Cron Name | Schedule | Service | Purpose |
|---|---|---|---|
| `bulk-page-create-cron` | `*/2 * * * ? *` (every 2 min) | page-service | Process bulk page creation queue |
| `event-reminder-cron` | `30 10 * * ? *` (daily 10:30 AM) | job-service | Send event reminder notifications |
| `challenge-remember-mail-cron` | `*/1 * * * ? *` (every 1 min) | job-service | Send challenge reminder emails |
| `update-profile-remember-cron` | `30 10 * * ? *` (daily 10:30 AM) | user-services | Remind users to complete profiles |
| `bulkAlumniUploadCron` | `*/2 * * * ? *` (every 2 min) | user-services | Process bulk alumni CSV uploads from S3 |

### Example Configuration

```yaml
# serverless.yml (job-service)
functions:
  eventReminderCron:
    handler: app.server
    events:
      - schedule:
          rate: cron(30 10 * * ? *)
          enabled: true
```

---

## 7. AWS Rekognition

**Purpose:** Image content moderation. Moderation labels and confidence thresholds are stored in the database and used to flag inappropriate content in feed posts.

**Files:**
- `admin-service/models/image_rekognition_tag.js`
- `admin-service/services/image_rekognition_tags.js`
- `feed-services/models/image_rekognition_tag.js`
- `feed-services/controllers/v1/cron/cronController.js`

### Database Model

```js
// image_rekognition_tag model
{
  id, publicId,
  label,           // e.g. "Explicit Nudity", "Violence"
  confidence,      // threshold percentage
  action,          // "Blocked" | "Flagged"
  deletedAt
}
```

### Usage in Content Moderation

```js
// cronController.js
const rules = await moderationService.moderationLabelsList({ where: { deletedAt: null } });
const invalidContent = await contentUtility.checkInvalidContent(description, rules);
let isFlagged = invalidContent?.action === "Blocked";
```

---

## 8. AWS Lambda Layers

**Purpose:** Shared dependencies across Lambda functions to reduce deployment package size and enable code reuse.

**Account:** `642627578700`  
**Region:** `eu-central-1`

| Layer ARN | Version | Used By |
|---|---|---|
| `arn:aws:lambda:eu-central-1:642627578700:layer:user-service` | v4, v5 | admin, feed, job, page, notification |
| `arn:aws:lambda:eu-central-1:642627578700:layer:feed-service` | v1 | admin, user |
| `arn:aws:lambda:eu-central-1:642627578700:layer:firebase-service` | v1 | admin, user, feed |
| `arn:aws:lambda:eu-central-1:642627578700:layer:job-service` | v1 | admin, user |
| `arn:aws:lambda:eu-central-1:642627578700:layer:page-service` | v1 | admin |
| `arn:aws:lambda:eu-central-1:642627578700:layer:notification-service` | v1 | admin, user, feed |
| `arn:aws:lambda:eu-central-1:642627578700:layer:pdf-service` | v1 | admin |
| `arn:aws:lambda:eu-central-1:642627578700:layer:puppeteer-core` | v1 | admin, linkedin-pdf |
| `arn:aws:lambda:eu-central-1:642627578700:layer:chromium` | v1 | admin, linkedin-pdf |
| `arn:aws:lambda:eu-central-1:642627578700:layer:mailchimp` | v1 | admin, notification |
| `arn:aws:lambda:eu-central-1:642627578700:layer:aws-sdk` | v2 | all services |

---

## 9. AWS Route 53

**Purpose:** DNS management for custom API domains.

| Domain | Environment | Linked To |
|---|---|---|
| `api.iit.twe.co` | Production | API Gateway (all services) |
| `devapi.iit.twe.co` | Development | API Gateway (all services) |
| `meassets.iit.twe.co` | Production | CloudFront → S3 |
| `mevideo.iit.twe.co` | Production | Video output CDN |

**Configuration in serverless.yml:**
```yaml
customDomain:
  domainName: ${self:custom.secrets.DOMAIN}
  basePath: ${self:custom.secrets.DOMAIN_PREFIX}
  stage: ${self:custom.secrets.NODE_ENV}
  createRoute53Record: true   # ← auto-creates DNS record
```

---

## 10. AWS CloudWatch

**Purpose:** Automatic logging for all Lambda function executions.

Every Lambda function writes stdout/stderr to CloudWatch Logs automatically. Log groups follow the pattern:

```
/aws/lambda/{function-name}
```

**Tail logs via CLI:**
```bash
# admin-service
sls logs -f app -t --aws-profile iit

# any service (from that service directory)
cd admin-service && sls logs -f app -t --aws-profile iit
```

---

## 11. AWS IAM

**Purpose:** Authentication for all AWS API calls and deployments.

| Profile | Usage |
|---|---|
| `iit` | All `sls deploy` and `sls logs` commands |

**Credentials referenced in code:**
```
ACCESS_KEY        → S3, CloudFront operations
SECRET_ACCESS_KEY → S3, CloudFront operations
TEXT_DETECT_ACCESS_ID  → Rekognition / text detection
TEXT_DETECT_ACCESS_KEY → Rekognition / text detection
```

---

## 12. Inactive / Disabled AWS Services

| Service | Status | Notes |
|---|---|---|
| **AWS Comprehend** | ⚠️ Disabled | Layer ARN exists in feed-services serverless.yml but is commented out. Was intended for NLP/text analysis. |
| **AWS ElastiCache (Redis)** | ⚠️ Disabled | Redis client configured in `admin-service/utilities/redis.utilities.js`. `REDIS_ENABLE=false` in all envs. Local Redis at `127.0.0.1:6379`. |

---

## Environment Configuration Summary

### Production

```
AWS_REGION=eu-central-1
S3_REGION=me-central-1
BUCKET_NAME=meassets.iit.co
VIDEO_BUCKET_NAME=meupload.iit.co
BULK_BUCKET_NAME=me-iit-prod-bulk-assets
MEDIA_OPTIMIZE_BUKCET=me-iit-optimize-media-prod
VIDEO_OPTIMIZE_BUCKET=video-recognition-iit-prod
DISTRIBUTION_ID=E28C4RQHF7WJU9
INVALID_CONTENT_SQS=https://sqs.me-central-1.amazonaws.com/642627578700/dev-post-invalid-content
IMAGE_URL=https://meassets.iit.twe.co/
OUTPUT_URL=https://mevideo.iit.twe.co/
```

### Development

```
AWS_REGION=eu-central-1
S3_REGION=me-central-1
BUCKET_NAME=medevassets.iit.co
VIDEO_BUCKET_NAME=medevupload.iit.co
BULK_BUCKET_NAME=me-iit-dev-bulk-assets
MEDIA_OPTIMIZE_BUKCET=me-iit-optimize-media-dev
VIDEO_OPTIMIZE_BUCKET=video-recognition-iit-dev
DISTRIBUTION_ID=EMJP8JYPDXXX4
```

---

## Service-to-AWS-Service Matrix

| Microservice | Lambda | API GW | S3 | CloudFront | SQS | EventBridge | Rekognition | Layers |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| admin-service | ✅ | ✅ | ✅ | ✅ | ✅ (producer) | ❌ | ✅ | ✅ |
| feed-services | ✅ | ✅ | ❌ | ❌ | ✅ (consumer) | ❌ | ✅ | ✅ |
| firebase-service | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| job-service | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ |
| linkedin-pdf | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| notification-service | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| page-service | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |
| user-services | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ |

---

## Quick Reference — API Endpoints by Service

### admin-service → `api.iit.twe.co/admin-v1`
Manages: users, categories, challenges, events, content moderation, bulk uploads, feed management, analytics

### user-services → `api.iit.twe.co/user-v1`
Manages: auth (JWT/Google/LinkedIn/Microsoft), profiles, connections, notifications, alumni bulk upload

### feed-services → `api.iit.twe.co/feed-v1`
Manages: posts, comments, likes, content moderation (SQS consumer)

### notification-service → `api.iit.twe.co/notification-v1`
Manages: push notifications (OneSignal), email (Mailchimp transactional)

### page-service → `api.iit.twe.co/page-v1`
Manages: meta JSON files in S3, CloudFront cache invalidation, bulk page creation

### firebase-service → `api.iit.twe.co/firebase-v1`
Manages: Firebase auth tokens, dynamic links, real-time features

### linkedin-pdf → `api.iit.twe.co/pdf-v1`
Manages: PDF generation from LinkedIn profiles using Puppeteer + Chromium Lambda layer

### job-service → `api.iit.twe.co/job-v1`
Manages: job listings, event reminders, challenge notifications (cron-driven)

---

*Generated from codebase analysis — June 2026*
xcvb
