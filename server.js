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
  STORE_API_KEY,
  WEBENGAGE_LICENSE_CODE,
  WEBENGAGE_API_KEY,
  FIRE_JOIN_EVENT,
  PORT = 8080,
} = process.env;

const db = new Firestore();
const COL_TXN = "txn_invites";
const COL_INV = "invite_lookup";

const trace = (tag, msg, data = null) => {
  console.log(
    `[${tag}] ${msg}${data ? " | DATA: " + JSON.stringify(data) : ""}`
  );
};

async function fireWebEngage(userId, eventName, eventData) {
  const url = `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`;

  const payload = {
    userId: String(userId),
    eventName,
    eventData,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEBENGAGE_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.text();
    trace("WEBENGAGE", `Status ${res.status}`, body);
    return res.ok;
  } catch (err) {
    trace("WEBENGAGE", "ERROR", err.message);
    return false;
  }
}

async function createTelegramLink(transactionId) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL_ID,
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 172800,
        name: `TXN:${transactionId}`.slice(0, 255),
      }),
    }
  );

  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
  return data.result.invite_link;
}

app.get("/healthz", (_, res) => res.send("ok"));

// app.post("/create-invite", async (req, res) => {
//   const apiKey = req.header("x-api-key");
//   const { userId, telegramUserId, transactionId } = req.body;

//   if (apiKey !== STORE_API_KEY) return res.sendStatus(401);
//   if (!userId || !telegramUserId || !transactionId)
//     return res.sendStatus(400);

//   try {
//     const inviteLink = await createTelegramLink(transactionId);

//     const inviteHash = crypto
//       .createHash("sha256")
//       .update(inviteLink)
//       .digest("hex");

//     const batch = db.batch();

//     batch.set(db.collection(COL_TXN).doc(transactionId), {
//       userId,
//       telegramUserId,
//       transactionId,
//       inviteHash,
//       inviteLink,
//       joined: false,
//       createdAt: FieldValue.serverTimestamp(),
//     });

//     batch.set(db.collection(COL_INV).doc(inviteHash), {
//       userId,
//       telegramUserId,
//       transactionId,
//       inviteLink,
//       createdAt: FieldValue.serverTimestamp(),
//     });

//     await batch.commit();

//     await fireWebEngage(
//       userId,
//       "pass_paid_community_telegram_link_created",
//       {
//         transactionId,
//         inviteLink,
//       }
//     );

//     res.json({ ok: true, inviteLink });
//   } catch (err) {
//     trace("ERROR", err.message);
//     res.status(500).json({ ok: false });
//   }
// });


app.post("/create-invite", async (req, res) => {
  const apiKey = req.header("x-api-key");
  const { userId, telegramUserId, transactionId } = req.body;

  if (apiKey !== STORE_API_KEY) return res.sendStatus(401);
  if (!userId || !transactionId) return res.sendStatus(400);

  try {
    const inviteLink = await createTelegramLink(transactionId);

    const inviteHash = crypto
      .createHash("sha256")
      .update(inviteLink)
      .digest("hex");

    const batch = db.batch();

    batch.set(db.collection(COL_TXN).doc(transactionId), {
      userId,
      telegramUserId: telegramUserId || null,
      transactionId,
      inviteHash,
      inviteLink,
      joined: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    batch.set(db.collection(COL_INV).doc(inviteHash), {
      userId,
      telegramUserId: telegramUserId || null,
      transactionId,
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
      }
    );

    res.json({ ok: true, inviteLink });
  } catch (err) {
    trace("ERROR", err.message);
    res.status(500).json({ ok: false });
  }
});

app.post("/telegram-webhook", async (req, res) => {
  if (FIRE_JOIN_EVENT !== "true") return res.send("ignored");

  const cm = req.body.chat_member || req.body.my_chat_member;
  if (!cm) return res.send("ignored");

  const inviteLink = cm?.invite_link?.invite_link;
  const status = cm?.new_chat_member?.status;

  if (!inviteLink || !["member", "administrator", "creator"].includes(status))
    return res.send("ignored");

  const inviteHash = crypto
    .createHash("sha256")
    .update(inviteLink)
    .digest("hex");

  const snap = await db.collection(COL_INV).doc(inviteHash).get();
  if (!snap.exists) return res.send("not_found");

  const { transactionId, userId, telegramUserId } = snap.data();
  const txnRef = db.collection(COL_TXN).doc(transactionId);

  let fire = false;

  await db.runTransaction(async (t) => {
    const s = await t.get(txnRef);
    if (s.exists && !s.data().joined) {
      t.update(txnRef, {
        joined: true,
        joinedAt: FieldValue.serverTimestamp(),
      });
      fire = true;
    }
  });

  if (fire) {
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
  trace("SYSTEM", `Listening on ${PORT}`)
);
