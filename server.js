"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

// Polyfill fetch for Node environments
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============= CONFIGURATION =============
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_ID,
  WEBENGAGE_LICENSE_CODE,
  WEBENGAGE_API_KEY,
  STORE_API_KEY,
  PORT = 8080,
} = process.env;

const db = new Firestore();

// Collection Constants
const COL_TXN = "txn_invites";    
const COL_INV = "invite_lookup";  

// ============= LOGGING HELPERS =============
const log = (tag, message, data = "") => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${tag}] ${message}`, data ? JSON.stringify(data) : "");
};

// ============= LOGIC HELPERS =============
const getUnixTimeSeconds = () => Math.floor(Date.now() / 1000);
const hashInviteLink = (link) => crypto.createHash("sha256").update(String(link || "")).digest("hex");

// ============= WEBENGAGE ENGINE =============
async function webengageFireEvent({ userId, eventName, eventData }) {
  // Global endpoint (Confirmed working with 201 in your logs)
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE.trim()}/events`;
  
  const payload = {
    userId: String(userId),
    eventName,
    eventTime: getUnixTimeSeconds(),
    eventData
  };

  log("WEBENGAGE", `Attempting event: ${eventName} for User: ${userId}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WEBENGAGE_API_KEY.trim()}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    if (res.ok) {
      log("WEBENGAGE", `✅ Success: ${eventName}`, { status: res.status, body });
    } else {
      log("WEBENGAGE", `❌ Failed: ${eventName}`, { status: res.status, body });
    }
    return res.ok;
  } catch (err) {
    log("WEBENGAGE", `🛑 Network Error: ${err.message}`);
    return false;
  }
}

// ============= TELEGRAM ENGINE =============
async function telegramCreateInviteLink(channelId, name) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  
  log("TELEGRAM", `Creating link for: ${name}`);
  
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      member_limit: 1, 
      expire_date: getUnixTimeSeconds() + (48 * 60 * 60),
      name: String(name || "").slice(0, 255),
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    log("TELEGRAM", `❌ API Error`, data);
    throw new Error(`TG_API_ERROR: ${data.description}`);
  }
  
  log("TELEGRAM", `✅ Link created successfully`);
  return data.result.invite_link;
}

// ============= ENDPOINTS =============

// 1. Health Probe
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// 2. Create Invite & Map (POST)
app.post("/create-invite", async (req, res) => {
  const { userId, transactionId } = req.body;
  log("API", `RECEIVED /create-invite`, { userId, transactionId });

  try {
    // Auth Check
    const apiKey = req.header("x-api-key");
    if (apiKey !== STORE_API_KEY) {
      log("API", `❌ Unauthorized attempt with key: ${apiKey}`);
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    if (!userId || !transactionId) {
      log("API", `❌ Missing required fields`);
      return res.status(400).json({ ok: false, error: "Missing data" });
    }

    // A. Generate Link
    const inviteLink = await telegramCreateInviteLink(TELEGRAM_CHANNEL_ID, `UID:${userId}|TXN:${transactionId}`);
    const invHash = hashInviteLink(inviteLink);

    // B. Save to Firestore (Atomic Batch)
    log("DB", `Saving mapping for TXN: ${transactionId}`);
    const batch = db.batch();
    batch.set(db.collection(COL_TXN).doc(transactionId), { userId, transactionId, inviteLink, inviteHash: invHash, joined: false, createdAt: new Date().toISOString() });
    batch.set(db.collection(COL_INV).doc(invHash), { transactionId, userId, inviteLink });
    await batch.commit();
    log("DB", `✅ Records saved`);

    // C. Notify WebEngage
    await webengageFireEvent({
      userId,
      eventName: "pass_paid_community_telegram_link_created",
      eventData: { transactionId, inviteLink }
    });

    res.json({ ok: true, inviteLink });
  } catch (err) {
    log("CRITICAL", `Error in /create-invite: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. Telegram Webhook (Join Tracker)
app.post("/telegram-webhook", async (req, res) => {
  const upd = req.body.chat_member || req.body.my_chat_member || req.body;
  const inviteLink = upd?.invite_link?.invite_link;
  const newStatus = upd?.new_chat_member?.status;

  log("WEBHOOK", `Processing update for status: ${newStatus}`);

  try {
    if (!["member", "administrator", "creator"].includes(newStatus)) return res.send("ignored_status");
    if (!inviteLink) return res.send("no_link_present");

    const invHash = hashInviteLink(inviteLink);
    const invSnap = await db.collection(COL_INV).doc(invHash).get();

    if (!invSnap.exists) {
      log("WEBHOOK", `❌ Orphan join detected for link hash: ${invHash}`);
      return res.send("link_not_found_in_db");
    }

    const { transactionId, userId } = invSnap.data();
    const txnRef = db.collection(COL_TXN).doc(transactionId);

    let shouldFire = false;
    await db.runTransaction(async (t) => {
      const snap = await t.get(txnRef);
      if (snap.exists && !snap.data().joined) {
        t.update(txnRef, { joined: true, telegramUserId: upd?.new_chat_member?.user?.id, joinedAt: new Date().toISOString() });
        shouldFire = true;
      }
    });

    if (shouldFire) {
      log("WEBHOOK", `✅ Join verified for User: ${userId}. Firing WebEngage.`);
      await webengageFireEvent({
        userId,
        eventName: "pass_paid_community_telegram_joined",
        eventData: { transactionId, inviteLink }
      });
    }

    res.send("ok");
  } catch (err) {
    log("CRITICAL", `Webhook Error: ${err.message}`);
    res.status(200).send("logged"); 
  }
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
  log("SYSTEM", `🚀 Bridge Online and Listening on Port ${PORT}`);
});
