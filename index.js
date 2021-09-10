const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const crypto = require('crypto');
const app = express();

const Sentry = require("@sentry/node");
const Tracing = require("@sentry/tracing");

const MSG_TITLE_TTL = process.env.MSG_TITLE_TTL || 15 * 60

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


const sharp = require('sharp');
const morgan = require('morgan');
const multer = require('multer');
const Redis = require('ioredis');
const request = require('request-promise-native');
const sha1 = require('sha1');
// const Slack = require('slack-node');
const upload = multer({ storage: multer.memoryStorage() });

const SEVEN_DAYS = 7 * 24 * 60 * 60; // in seconds

const appURL = process.env.APP_URL;
const redis = new Redis(process.env.REDIS_URL);
const TOKEN = process.env.T_TOKEN || 'XXX';
const PLEX_TOKEN = process.env.PLEX_TOKEN || 'XXX';

const bot = new TelegramBot(TOKEN, { polling: true });

const channelId = '-1001304838206';

// Matches "/echo [whatever]"
bot.onText(/\/echo (.+)/, (msg, match) => {
  // 'msg' is the received Message from Telegram
  // 'match' is the result of executing the regexp above on the text content
  // of the message

  const chatId = msg.chat.id;
  const resp = match[1]; // the captured "whatever"

  // send back the matched "whatever" to the chat
  bot.sendMessage(chatId, resp);
});

// Listen for any kind of message. There are different kinds of
// messages.
bot.on('message', (msg) => {
  const chatId = msg.chat.id;

  // send a message to the chat acknowledging receipt of their message
  bot.sendMessage(chatId, 'Received your message');
  console.log(msg);
});

const slack = {};

//
// express

const port = process.env.PORT || 11000;

app.use(morgan('dev'));
app.listen(port, () => {
  console.log(`Express app running at http://localhost:${port}`);
});

//
// routes

app.post('/', upload.single('thumb'), async (req, res, next) => {
  const payload = JSON.parse(req.body.payload);

  // missing required properties
  if (!payload.user || !payload.Metadata) {
    console.log('not libray new', payload.event);
    return res.sendStatus(200);
  }

  
  const isVideo = (['movie', 'episode', 'show'].includes(payload.Metadata.type));
  const isAudio = (payload.Metadata.type === 'track');
  const key = sha1(payload.Server.uuid + payload.Metadata.ratingKey);

  if( !(isAudio || isVideo) ){
    const err = new Error('Payload not video or audio...')
    Sentry.captureException(err)
    console.error(err, payload);
    return res.sendStatus(400);
  }

  // retrieve cached image
  let image = await redis.getBuffer(key);

  // save new image
  if (payload.event === 'library.new') {
    console.log(payload);
    if (image) {
      console.log('[REDIS]', `Using cached image ${key}`);
    } else {
      let buffer;
      if (req.file && req.file.buffer) {
        buffer = req.file.buffer;
      } 
      if ((payload.Metadata.type == 'episode' && payload.Metadata.grandparentThumb) || payload.Metadata.thumb) {
        console.log('[REDIS]', `Retrieving image from  ${payload.Metadata.thumb}`);
        buffer = await request.get({
          uri: `http://plex.max.pach.one${payload.Metadata.type == 'episode' ? payload.Metadata.grandparentThumb : payload.Metadata.thumb}?X-Plex-Token=${PLEX_TOKEN}`,
          encoding: null
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

        console.log('[REDIS]', `Saving new image ${key}`);
        redis.set(key, image, 'EX', SEVEN_DAYS);
      }
    }

    if (image) {
      console.log('[SLACK]', `Sending ${key} with image`);
      notifyTelegram(appURL + '/images/' + key, payload);
    } else {
      console.log('[SLACK]', `Sending ${key} without image`);
      notifyTelegram(null, payload);
    }
  }

  res.sendStatus(200);

});

app.get('/images/:key', async (req, res, next) => {
  const exists = await redis.exists(req.params.key);

  if (!exists) {
    return next();
  }

  res.set('Content-Type', 'image/jpeg');
  const image = await redis.getBuffer(req.params.key);
  sharp(image).jpeg().pipe(res);
});

//
// error handlers

app.use((req, res, next) => {
  const err = new Error('Not Found');
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

function md5Text(text){
  return crypto.createHash('md5').update(text.toString()).digest("hex")  ;;
}

function formatTitle(metadata) {
  if (metadata.grandparentTitle) {
    return metadata.grandparentTitle;
  } else {
    let ret = metadata.title;
    if (metadata.year) {
      ret += ` (${metadata.year})`;
    }
    return ret;
  }
}

function formatSubtitle(metadata) {
  let ret = '';

  if (metadata.grandparentTitle) {
    if (metadata.type === 'track') {
      ret = metadata.parentTitle;
    } else if (metadata.index && metadata.parentIndex) {
      ret = `S${metadata.parentIndex} E${metadata.index}`;
    } else if (metadata.originallyAvailableAt) {
      ret = metadata.originallyAvailableAt;
    }

    if (metadata.title) {
      ret += ' - ' + metadata.title;
    }
  } else if (metadata.type === 'movie') {
    ret = metadata.summary;
  } else if (metadata.summary) {
    ret = metadata.summary;
  }

  return ret;
}

async function notifyTelegram(imageUrl, payload, action) {

  let rating = [];
  if(payload.Metadata.audienceRating)
    rating.push(`🍿 ${payload.Metadata.audienceRating}`)

  if(payload.Metadata.rating)
    rating.push(`📺 ${payload.Metadata.rating}`)
  
  const msgTitle = formatTitle(payload.Metadata);

  if(await redis.get(`title:${md5Text(msgTitle)}`)){
    return false;
  }
  await redis.setex(`title:${md5Text(msgTitle)}`, MSG_TITLE_TTL, 1);

  let message = `<strong>${msgTitle}</strong>
${formatSubtitle(payload.Metadata)}`;

  if(rating.length)
    message += `
${rating.join(' — ')}`;


  const params = new URLSearchParams();
  params.append('key', payload.Metadata.key);

  const url = `https://pach.rocks/web/index.html#!/server/766042f58d5012bd3547a0ac33bec2a8c8d805dd/details?${params.toString()}`;
  
  message += `
<a href='${url}'>🎬 MAX Media</a>`

  const opts = {
    caption: message,
    parse_mode: 'HTML',
    disable_notification: true
  };

  if(imageUrl){
    bot.sendPhoto(channelId, imageUrl, opts);
  } else {
    bot.sendMessage(channelId, message, opts);
  }
}
