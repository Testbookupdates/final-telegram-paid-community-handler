"use strict";

const express = require("express");
const crypto = require("crypto");
const { Firestore, FieldValue } = require("@google-cloud/firestore");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json({ limit: "1mb" }));

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

const trace = (tag, message, data = null) => {
  const meta = data ? ` | DATA: ${JSON.stringify(data)}` : "";
  console.log(`[${tag}] ${message}${meta}`);
};

async function fireWebEngage(userId, eventName, eventData) {
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE.trim()}/events`;

  const payload = {
    userId: String(userId),
    eventName,
    eventData,
  };

  const auth = Buffer.from(`${WEBENGAGE_API_KEY.trim()}:`).toString("base64");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    trace("WEBENGAGE", `Status: ${res.status}`, body);
    return res.ok;
  } catch (err) {
    trace("WEBENGAGE", "ERROR", err.message);
    return false;
  }
}

async function createTelegramLink(telegramUserId, transactionId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHANNEL_ID,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 48 * 60 * 60,
      name: `TG:${telegramUserId}|TXN:${transactionId}`.slice(0, 255),
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
  return data.result.invite_link;
}

app.get("/healthz", (_, res) => res.status(200).send("ok"));

app.post("/create-invite", async (req, res) => {
  const { userId, telegramUserId, transactionId } = req.body;
  const apiKey = req.header("x-api-key");

  if (apiKey !== STORE_API_KEY) return res.status(401).send("Unauthorized");
  if (!userId || !telegramUserId || !transactionId)
    return res.status(400).send("Missing Params");

  try {
    const inviteLink = await createTelegramLink(
      telegramUserId,
      transactionId
    );

    const inviteHash = crypto
      .createHash("sha256")
      .update(inviteLink)
      .digest("hex");

    const batch = db.batch();

    batch.set(db.collection(COL_TXN).doc(transactionId), {
      userId,
      telegramUserId,
      transactionId,
      inviteLink,
      inviteHash,
      joined: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    batch.set(db.collection(COL_INV).doc(inviteHash), {
      transactionId,
      userId,
      telegramUserId,
      inviteLink,
      createdAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    await fireWebEngage(
      userId,
      "pass_paid_community_telegram_link_created",
      {
        transactionId,
        inviteLink,
        telegramUserId,
      }
    );

    res.json({ ok: true, inviteLink });
  } catch (err) {
    trace("CRITICAL", "ERROR", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/telegram-webhook", async (req, res) => {
  const cm = req.body.chat_member || req.body.my_chat_member;
  if (!cm) return res.send("ignored");

  const inviteLink = cm?.invite_link?.invite_link;
  const newStatus = cm?.new_chat_member?.status;

  if (!inviteLink || !["member", "administrator", "creator"].includes(newStatus))
    return res.send("ignored");

  const inviteHash = crypto
    .createHash("sha256")
    .update(inviteLink)
    .digest("hex");

  const invSnap = await db.collection(COL_INV).doc(inviteHash).get();
  if (!invSnap.exists) return res.send("not_found");

  const { transactionId, userId, telegramUserId } = invSnap.data();
  const txnRef = db.collection(COL_TXN).doc(transactionId);

  let shouldFire = false;

  await db.runTransaction(async (t) => {
    const snap = await t.get(txnRef);
    if (snap.exists && !snap.data().joined) {
      t.update(txnRef, {
        joined: true,
        joinedAt: FieldValue.serverTimestamp(),
      });
      shouldFire = true;
    }
  });

  if (shouldFire) {
    await fireWebEngage(
      userId,
      "pass_paid_community_telegram_joined",
      {
        transactionId,
        inviteLink,
        joined: true,
        telegramUserId,
      }
    );
  }

  res.send("ok");
});

app.listen(PORT, "0.0.0.0", () =>
  trace("SYSTEM", `Service Listening on Port ${PORT}`)
);
