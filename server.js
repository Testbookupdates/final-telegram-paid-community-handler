import express from "express";
import crypto from "crypto";
import { Firestore } from "@google-cloud/firestore";
import { CloudTasksClient } from "@google-cloud/tasks";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  GCP_PROJECT,
  GCP_LOCATION = "asia-south1",
  TASKS_QUEUE = "tg-invite-queue",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  WEBENGAGE_LICENSE_CODE,
  WEBENGAGE_API_KEY,
  BASE_URL,
  MAX_ATTEMPTS = 50,
  BASE_BACKOFF_SEC = 5,
  SAFE_RPS_SLEEP_MS = 220,
} = process.env;

if (!GCP_PROJECT || !BASE_URL) {
  console.error("Missing required env vars");
  process.exit(1);
}

const db = new Firestore();
const tasks = new CloudTasksClient();

const WE_EVENT_LINK_CREATED = "pass_paid_community_telegram_link_created";
const WE_EVENT_JOINED = "pass_paid_community_telegram_joined";

function uuid() {
  return crypto.randomUUID();
}

function sha256(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}

async function enqueueWorker(requestId, delay = 0) {
  const parent = tasks.queuePath(GCP_PROJECT, GCP_LOCATION, TASKS_QUEUE);

  const task = {
    httpRequest: {
      httpMethod: "POST",
      url: `${BASE_URL}/v1/invite/worker`,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ requestId })).toString("base64"),
    },
  };

  if (delay > 0) {
    task.scheduleTime = {
      seconds: Math.floor(Date.now() / 1000) + delay,
    };
  }

  await tasks.createTask({ parent, task });
}

async function telegramCreateInvite(chatId, name) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createChatInviteLink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        member_limit: 1,
        name: String(name).slice(0, 255),
      }),
    }
  );

  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function fireWebEngage({ userId, eventName, eventData }) {
  const res = await fetch(
    `https://api.webengage.com/v1/accounts/${WEBENGAGE_LICENSE_CODE}/events`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WEBENGAGE_API_KEY}`,
      },
      body: JSON.stringify({ userId, eventName, eventData }),
    }
  );
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 800) };
}

app.post("/v1/invite/request", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const transactionId = String(req.body?.transactionId || "").trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId required" });
    }

    const requestId = uuid();

    await db.collection("invite_requests").doc(requestId).set({
      requestId,
      userId,
      transactionId,
      status: "QUEUED",
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      weLinkEventFired: false,
      joinEventFired: false,
    });

    await enqueueWorker(requestId, 0);

    res.json({ ok: true, status: "queued", requestId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/v1/invite/result/:requestId", async (req, res) => {
  try {
    const requestId = String(req.params.requestId || "").trim();
    if (!requestId) {
      return res.status(400).json({ ok: false, error: "requestId required" });
    }

    const snap = await db.collection("invite_requests").doc(requestId).get();
    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "not found" });
    }

    const data = snap.data();

    if (data.status !== "DONE") {
      return res.json({
        ok: true,
        status: data.status,   // QUEUED or PROCESSING
      });
    }

    return res.json({
      ok: true,
      status: "DONE",
      inviteLink: data.inviteLink,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/v1/invite/worker", async (req, res) => {
  try {
    const requestId = String(req.body?.requestId || "").trim();
    if (!requestId) return res.status(400).send("missing requestId");

    const ref = db.collection("invite_requests").doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(200).send("ok");

    const doc = snap.data();
    if (doc.status === "DONE") return res.status(200).send("ok");

    const attempts = (doc.attempts || 0) + 1;

    if (attempts > MAX_ATTEMPTS) {
      await ref.update({ status: "FAILED", updatedAt: new Date().toISOString() });
      return res.status(200).send("failed");
    }

    await ref.update({
      status: "PROCESSING",
      attempts,
      updatedAt: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, SAFE_RPS_SLEEP_MS));

    const tg = await telegramCreateInvite(TELEGRAM_CHAT_ID, requestId);

    if (!tg.ok) {
      const retryAfter =
        Number(tg.json?.parameters?.retry_after) || 0;

      const delay =
        retryAfter > 0
          ? retryAfter + 1
          : Math.min(3600, BASE_BACKOFF_SEC * Math.pow(2, attempts));

      await ref.update({ status: "QUEUED", updatedAt: new Date().toISOString() });
      await enqueueWorker(requestId, delay);

      return res.status(200).send("retry scheduled");
    }

    const inviteLink = tg.json?.result?.invite_link;
    const hash = sha256(inviteLink);

    await db.collection("invite_links").doc(hash).set({
      inviteLink,
      requestId,
      userId: doc.userId,
      transactionId: doc.transactionId || "",
      createdAt: new Date().toISOString(),
    });

    await ref.update({
      status: "DONE",
      inviteLink,
      updatedAt: new Date().toISOString(),
    });

    if (!doc.weLinkEventFired) {
      const we = await fireWebEngage({
        userId: doc.userId,
        eventName: WE_EVENT_LINK_CREATED,
        eventData: {
          transactionId: doc.transactionId || "",
          inviteLink,
        },
      });

      await ref.update({ weLinkEventFired: we.ok });
    }

    res.status(200).send("ok");
  } catch {
    res.status(200).send("ok");
  }
});

app.post("/v1/telegram/webhook", async (req, res) => {
  try {
    const upd = req.body?.chat_member || req.body?.my_chat_member;
    if (!upd) return res.status(200).send("ignored");

    const inviteLink = String(upd?.invite_link?.invite_link || "").trim();
    const telegramUserId = String(upd?.new_chat_member?.user?.id || "").trim();
    const status = upd?.new_chat_member?.status;

    if (!inviteLink || !telegramUserId) return res.status(200).send("ignored");
    if (!["member", "administrator", "creator"].includes(status)) {
      return res.status(200).send("ignored");
    }

    const hash = sha256(inviteLink);

    const linkSnap = await db.collection("invite_links").doc(hash).get();
    if (!linkSnap.exists) return res.status(200).send("ok");

    const linkDoc = linkSnap.data();
    const reqRef = db.collection("invite_requests").doc(linkDoc.requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) return res.status(200).send("ok");

    const reqDoc = reqSnap.data();
    if (reqDoc.joinEventFired) return res.status(200).send("ok");

    const we = await fireWebEngage({
      userId: reqDoc.userId,
      eventName: WE_EVENT_JOINED,
      eventData: {
        transactionId: reqDoc.transactionId || "",
        inviteLink,
        telegramUserId,
      },
    });

    await reqRef.update({
      joinEventFired: we.ok,
      telegramUserId,
      updatedAt: new Date().toISOString(),
    });

    res.status(200).send("ok");
  } catch {
    res.status(200).send("ok");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
