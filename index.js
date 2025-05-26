const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const crypto = require("crypto");
const app = express();
const serverless = require("serverless-http");

const Sentry = require("@sentry/node");
const Tracing = require("@sentry/tracing");

const FUNCTIONS = require('@vercel/functions');

const MSG_TITLE_TTL = process.env.MSG_TITLE_TTL || 20 * 60;

Sentry.init({
  release: "plex-notifications@" + process.env.npm_package_version,

  dsn: process.env.SENTRY_DSN,
  integrations: [
    // enable HTTP calls tracing
    new Sentry.Integrations.Http({ tracing: true }),
    // enable Express.js middleware tracing
    new Tracing.Integrations.Express({ app }),
  ],
  // We recommend adjusting this value in production, or using tracesSampler
  // for finer control
  tracesSampleRate: 1.0,
});

app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

const sharp = require("sharp");
const morgan = require("morgan");
const multer = require("multer");
const Redis = require("ioredis");
const request = require("request-promise-native");
const sha1 = require("sha1");
const upload = multer({ storage: multer.memoryStorage() });

const SEVEN_DAYS = 7 * 24 * 60 * 60; // in seconds

const appURL = process.env.APP_URL;
const redis = new Redis(process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL);
const TOKEN = process.env.T_TOKEN || "XXX";
const PLEX_TOKEN = process.env.PLEX_TOKEN || "XXX";

const bot = new TelegramBot(TOKEN, { polling: false });

const channelId = "-1001304838206";

const port = process.env.PORT || 11000;

app.use(morgan("combined"));
app.listen(port, () => {
  console.log(`Express app running at http://localhost:${port}`);
});

//
// routes

app.post("/webhook", upload.single("thumb"), async (req, res, next) => {
  const payload = JSON.parse(req.body.payload);

  // missing required properties
  if (!payload.user || !payload.Metadata) {
    console.log("not libray new", payload.event);
    return res.sendStatus(200);
  }

  const isVideo = ["movie", "episode", "show"].includes(payload.Metadata.type);
  const isAudio = payload.Metadata.type === "track";
  const key = sha1(payload.Server.uuid + payload.Metadata.ratingKey);

  if (!(isAudio || isVideo)) {
    const err = new Error("Payload not video or audio...");
    Sentry.captureException(err);
    console.error(err, payload);
    return res.sendStatus(400);
  }

  // retrieve cached image
  let image = await redis.getBuffer(key);

  // save new image
  if (payload.event === "library.new") {
    console.log(payload);
    if (image) {
      console.log("[REDIS]", `Using cached image ${key}`);
    } else {
      let buffer;
      if (req.file && req.file.buffer) {
        buffer = req.file.buffer;
      }
      if (
        (payload.Metadata.type == "episode" &&
          payload.Metadata.grandparentThumb) ||
        payload.Metadata.thumb
      ) {
        console.log(
          "[REDIS]",
          `Retrieving image from  ${payload.Metadata.thumb}`
        );
        buffer = await request.get({
          uri: `https://plex.max.pach.one${
            payload.Metadata.type == "episode"
              ? payload.Metadata.grandparentThumb
              : payload.Metadata.thumb
          }?X-Plex-Token=${PLEX_TOKEN}`,
          encoding: null,
        });
      }
      if (buffer) {
        image = await sharp(buffer)
          // .resize({
          //   height: 75,
          //   width: 75,
          //   fit: 'contain',
          //   background: 'white'
          // })
          .toBuffer();

        console.log("[REDIS]", `Saving new image ${key}`);
        redis.set(key, image, "EX", SEVEN_DAYS);
      }
    }

    if (image) {
      console.log("[Telegram]", `Sending ${key} with image`);
      FUNCTIONS.waitUntil(notifyTelegram(appURL + "/images/" + key, payload).catch(console.error));
    } else {
      console.log("[Telegram]", `Sending ${key} without image`);
      FUNCTIONS.waitUntil(notifyTelegram(null, payload).catch(console.error));
    }
  }

  res.sendStatus(200);
});

app.get("/images/:key", async (req, res, next) => {
  const exists = await redis.exists(req.params.key);

  if (!exists) {
    return next();
  }

  res.set("Content-Type", "image/jpeg");
  const image = await redis.getBuffer(req.params.key);
  sharp(image).jpeg().pipe(res);
});

//
// error handlers

app.use((req, res, next) => {
  const err = new Error("Not Found");
  err.status = 404;
  next(err);
});

app.use(Sentry.Handlers.errorHandler());

app.use((err, req, res, next) => {
  res.status(err.status || 500);
  res.send(err.message);
});

//
// helpers

function md5Text(text) {
  return crypto.createHash("md5").update(text.toString()).digest("hex");
}

function formatTitle(metadata) {
  if (metadata.grandparentTitle) {
    return metadata.grandparentTitle;
  } else {
    let ret = metadata.title;
    if (metadata.year && !metadata.title.includes(`${metadata.year}`)) {
      ret += ` (${metadata.year})`;
    }
    return ret;
  }
}

function formatSlug(metadata) {
  if (metadata.grandparentSlug) {
    return metadata.grandparentSlug;
  }

  if (metadata.parentSlug) {
    return metadata.parentSlug;
  }

  if (metadata.slug) {
    return metadata.slug;
  }

  return null;
}

function formatSubtitle(metadata) {
  let ret = "";

  if (metadata.grandparentTitle) {
    if (metadata.type === "track") {
      ret = metadata.parentTitle;
    } else if (metadata.index && metadata.parentIndex) {
      ret = `S${metadata.parentIndex} E${metadata.index}`;
    } else if (metadata.originallyAvailableAt) {
      ret = metadata.originallyAvailableAt;
    }

    if (metadata.title) {
      ret += " - " + metadata.title;
    }
  } else if (metadata.type === "movie") {
    ret = metadata.summary;
  } else if (metadata.summary) {
    ret = metadata.summary;
  }

  return ret;
}

function formatLibrary(metadata) {
  if (metadata.librarySectionTitle) {
    return metadata.librarySectionTitle;
  }

  return "MAX Media";
}

async function notifyTelegram(imageUrl, payload, action) {
  console.log('now in notifyTelegram')
  let rating = [];
  if (payload.Metadata.audienceRating)
    rating.push(`🍿 ${payload.Metadata.audienceRating}`);

  if (payload.Metadata.rating)
    rating.push(`📺 ${payload.Metadata.rating}`);

  const msgTitle = formatTitle(payload.Metadata);
  const slug = formatSlug(payload.Metadata);

  if (slug && (await redis.get(`slug:${md5Text(slug)}`))) {
    console.log("skipping", slug, md5Text(slug));
    return false;
  }

  if (slug) await redis.setex(`slug:${md5Text(slug)}`, MSG_TITLE_TTL, 1);

  let message = `<strong>${msgTitle}</strong>
${formatSubtitle(payload.Metadata)}`;

  if (rating.length)
    message += `
${rating.join(" — ")}`;

  const params = new URLSearchParams();
  params.append("key", payload.Metadata.key.replace("/children", ""));

  const url = `https://pach.rocks/web/index.html#!/server/${payload.Server?.uuid}/details?${params.toString()}`;

  const library = formatLibrary(payload.Metadata);

  message += `
<a href='${url}'>🎬 ${library}</a>`;

  const opts = {
    caption: message,
    parse_mode: "HTML",
    disable_notification: true,
  };

  console.log('got the message ready');

  if (imageUrl) {
    await bot.sendPhoto(channelId, imageUrl, opts).then(console.log).catch(console.error);
  } else {
    await bot.sendMessage(channelId, message, opts).then(console.log).catch(console.error);
  }
  console.log("telegram message sent");
}

console.log("Serverless function 'telegram-bot' initialized...");

module.exports = app;
module.exports.handler = serverless(app);