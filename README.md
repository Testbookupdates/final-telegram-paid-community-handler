# Telegram Paid Community Automation

Scalable Telegram invite link generation + join tracking system using:

* Cloud Run
* Firestore (Native)
* Cloud Tasks (rate-limited worker)
* WebEngage Events

Designed for high scale (millions of links) without Firestore collection scans.

---

# 🚀 What This System Does

After a purchase event:

1. WebEngage calls your API
2. Request is queued immediately
3. Cloud Tasks processes invite generation safely (rate-limited)
4. Invite link is stored
5. WebEngage "link created" event is fired
6. When user joins Telegram, webhook fires "joined" event

Fully retry-safe, idempotent, and rate-limit aware.

---

# 🏗 Architecture Overview

WebEngage → Cloud Run → Firestore → Cloud Tasks → Worker → Telegram
↓
WebEngage Event (Link Created)

Telegram Webhook → Cloud Run → Firestore Lookup → WebEngage Event (Joined)

---

# 🔁 Flow Explained

## 1️⃣ Invite Link Creation Flow

Step 1: WebEngage Journey calls:
POST /v1/invite/request

Step 2: Backend:

* Creates Firestore document (status=QUEUED)
* Enqueues Cloud Task
* Returns immediately: { status: "queued" }

Step 3: Cloud Tasks delivers jobs one-by-one
(maxConcurrentDispatches = 1)

Step 4: Worker:

* Calls Telegram createChatInviteLink
* Handles 429 with retry_after
* Saves invite link
* Fires WebEngage event:

pass_paid_community_telegram_link_created

---

## 2️⃣ Telegram Join Tracking Flow

Step 1: User joins using invite link

Step 2: Telegram sends webhook:
POST /v1/telegram/webhook

Step 3: Backend:

* Filters only join-type updates
* Hashes inviteLink
* Lookup via direct Firestore document read
* Fires WebEngage event:

pass_paid_community_telegram_joined

Step 4: Marks joinEventFired = true (idempotent)

---

# 🧱 GCP Architecture

Region: asia-south1 (Mumbai)

Services Used:

* Cloud Run (single service, 3 endpoints)
* Firestore (Native mode)
* Cloud Tasks
* Secret Manager
* Cloud Logging

---

# 📂 Firestore Data Model

## Collection: invite_requests

Document ID: requestId (uuid)

Fields:
requestId
userId
transactionId (can be "")
status (QUEUED | PROCESSING | DONE | FAILED)
attempts
createdAt
updatedAt
inviteLink
telegramChatId
weLinkEventFired
joinEventFired
telegramUserId

---

## Collection: invite_links

Document ID: sha256(inviteLink)

Fields:
inviteLink
requestId
userId
transactionId
createdAt

Why this exists?

Webhook lookup is O(1).

Each join performs:

* 1 read on invite_links/{hash}
* 1 read on invite_requests/{id}
* 1 update write

No collection scans.
No "3 million row" billing risk.

---

# 🔌 API Endpoints

## POST /v1/invite/request

Used by WebEngage

Body:
{
"userId": "12345",
"transactionId": "txn_abc"
}

Response:
{
"ok": true,
"status": "queued",
"requestId": "uuid"
}

---

## POST /v1/invite/worker

Used internally by Cloud Tasks
Handles:

* Telegram API call
* Retry scheduling
* Fire WE link event

Do NOT call manually in production.

---

## POST /v1/telegram/webhook

Used by Telegram webhook
Handles:

* Join filtering
* Mapping lookup
* Fire WE joined event
* Idempotency

---

# 🔐 Required Environment Variables

GCP_PROJECT
GCP_LOCATION=asia-south1
TASKS_QUEUE=tg-invite-queue
BASE_URL=[https://your-cloud-run-url](https://your-cloud-run-url)
TELEGRAM_CHAT_ID=-100xxxxxxxxxx
MAX_ATTEMPTS=50
BASE_BACKOFF_SEC=5
SAFE_RPS_SLEEP_MS=220

Secrets (Secret Manager):

TELEGRAM_BOT_TOKEN
WEBENGAGE_LICENSE_CODE
WEBENGAGE_API_KEY

---

# ☁️ GCP Setup Guide

Step 1 — Enable APIs

* Cloud Run
* Firestore
* Cloud Tasks
* Secret Manager
* Cloud Build

Step 2 — Create Firestore (Native mode)

Step 3 — Create Cloud Tasks Queue
Recommended config:
maxConcurrentDispatches = 1
maxDispatchesPerSecond = 5

Step 4 — Deploy Cloud Run

gcloud run deploy telegram-community-service 
--region asia-south1 
--source . 
--allow-unauthenticated

Step 5 — Set Telegram Webhook

[https://api.telegram.org/bot](https://api.telegram.org/bot)<TOKEN>/setWebhook?url=https://YOUR_URL/v1/telegram/webhook

Make sure:

* Bot is admin
* Bot can create invite links

Step 6 — Configure WebEngage Journey
Call API endpoint on purchase event:
POST /v1/invite/request

---

# 🔄 Retry Strategy

If Telegram returns HTTP 429:

* Read retry_after
* Reschedule Cloud Task
* No request is dropped

Fallback exponential backoff:
BASE_BACKOFF_SEC * 2^attempt

Max delay: 1 hour

---

# 💰 Cost Overview (High Scale Example)

Example:
3M invites
2M joins

Firestore:
~7M reads
~11M writes

Cloud Tasks:
~6M operations
First 1M free
$0.40 / million after

Cloud Run:
Depends on memory + execution time
Usually low if properly configured

---

# 🛡 Reliability Guarantees

✔ No link generation bursts
✔ Rate-limit aware
✔ Retry-safe
✔ Join idempotency
✔ No collection scans
✔ Handles millions of records

---

# 🧹 Recommended Maintenance

Implement cleanup job to:

* Delete old invite_requests
* Delete old invite_links
* Keep Firestore cost predictable

---

# 📌 Summary

This system is designed for:

* Flash sales
* Paid Telegram communities
* 100K+ requests/day
* Million-scale link generation
* Production reliability

Safe. Scalable. Cost-controlled.

---

If needed, this repo can be extended with:

* Dead letter queue (DLQ)
* Admin debug endpoints
* Monitoring dashboard
* IAM hardening guide
* CI/CD automation
