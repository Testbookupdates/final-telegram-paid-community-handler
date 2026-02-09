"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore } = require("@google-cloud/firestore");

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

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
const COL_TXN = "txn_invites";    
const COL_INV = "invite_lookup";  

// ============= LOGGING HELPER =============
const trace = (tag, message, data = null) => {
  const meta = data ? ` | DATA: ${JSON.stringify(data)}` : "";
  console.log(`[${tag}] ${message}${meta}`);
};

// ============= ENGINES =============

async function fireWebEngage(userId, eventName, eventData) {
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE.trim()}/events`;
  
  const payload = {
    userId: String(userId),
    eventName,
    eventTime: Math.floor(Date.now() / 1000),
    eventData
  };

  trace("WEBENGAGE", `Firing ${eventName} for ${userId}`);

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
    trace("WEBENGAGE", `Status: ${res.status} | Response: ${body}`);
    return res.ok;
  } catch (err) {
    trace("WEBENGAGE", `🛑 ERROR: ${err.message}`);
    return false;
  }
}

async function createTelegramLink(userId, transactionId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;
  
  trace("TELEGRAM", `Requesting link for UID: ${userId}`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHANNEL_ID,
      member_limit: 1, 
      expire_date: Math.floor(Date.now() / 1000) + (48 * 60 * 60),
      name: `UID:${userId}|TXN:${transactionId}`.slice(0, 255),
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    trace("TELEGRAM", "❌ Link creation failed", data);
    throw new Error(data.description);
  }
  return data.result.invite_link;
}

// ============= ENDPOINTS =============

app.get("/healthz", (_, res) => res.status(200).send("ok"));

app.post("/create-invite", async (req, res) => {
  const { userId, transactionId } = req.body;
  const apiKey = req.header("x-api-key");

  trace("API", "POST /create-invite", { userId, transactionId });

  if (apiKey !== STORE_API_KEY) return res.status(401).send("Unauthorized");
  if (!userId || !transactionId) return res.status(400).send("Missing Params");

  try {
    const inviteLink = await createTelegramLink(userId, transactionId);
    const invHash = crypto.createHash("sha256").update(inviteLink).digest("hex");

    trace("DB", `Saving TXN mapping: ${transactionId}`);
    const batch = db.batch();
    batch.set(db.collection(COL_TXN).doc(transactionId), { userId, transactionId, inviteLink, inviteHash: invHash, joined: false, createdAt: new Date().toISOString() });
    batch.set(db.collection(COL_INV).doc(invHash), { transactionId, userId, inviteLink });
    await batch.commit();

    await fireWebEngage(userId, "pass_paid_community_telegram_link_created", { transactionId, inviteLink });

    res.json({ ok: true, inviteLink });
  } catch (err) {
    trace("CRITICAL", `Error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/telegram-webhook", async (req, res) => {
  const upd = req.body.chat_member || req.body.my_chat_member || req.body;
  const inviteLink = upd?.invite_link?.invite_link;
  const newStatus = upd?.new_chat_member?.status;

  trace("WEBHOOK", `Processing status: ${newStatus}`);

  if (!["member", "administrator", "creator"].includes(newStatus) || !inviteLink) {
    return res.send("ignored");
  }

  const invHash = crypto.createHash("sha256").update(inviteLink).digest("hex");
  const invSnap = await db.collection(COL_INV).doc(invHash).get();

  if (!invSnap.exists) {
    trace("WEBHOOK", `❌ No DB entry for hash: ${invHash}`);
    return res.send("not_found");
  }

  const { transactionId, userId } = invSnap.data();
  const txnRef = db.collection(COL_TXN).doc(transactionId);

  let shouldFire = false;
  await db.runTransaction(async (t) => {
    const snap = await t.get(txnRef);
    if (snap.exists && !snap.data().joined) {
      t.update(txnRef, { joined: true, joinedAt: new Date().toISOString() });
      shouldFire = true;
    }
  });

  if (shouldFire) {
    trace("WEBHOOK", `✅ Join verified for User: ${userId}`);
    await fireWebEngage(userId, "pass_paid_community_telegram_joined", { transactionId, inviteLink });
  }

  res.send("ok");
});

app.listen(PORT, "0.0.0.0", () => trace("SYSTEM", `🚀 Service Listening on Port ${PORT}`));
