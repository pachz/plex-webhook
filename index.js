const express = require('express');
const sharp = require('sharp');
const morgan = require('morgan');
const multer = require('multer');
const Redis = require('ioredis');
const request = require('request-promise-native');
const sha1 = require('sha1');
const Slack = require('slack-node');
const upload = multer({storage: multer.memoryStorage()});
const Discord = require('discord.js');

const SEVEN_DAYS = 7 * 24 * 60 * 60; // in seconds

//
// media naming
const MEDIA_PLAYING = 'media.play';
const MEDIA_PAUSED = 'media.pause';
const MEDIA_RESUMED = 'media.resume';
const MEDIA_STOPPED = 'media.stop';
const MEDIA_VIEWED = 'media.scrobble';
const MEDIA_RATED = 'media.rate';

//
// setup

const channel = process.env.SLACK_CHANNEL;
const appURL = process.env.APP_URL;
const redis = new Redis(process.env.REDIS_URL);

//
// slack

const slack = new Slack();
slack.setWebhook(process.env.SLACK_URL);

//
// express

const app = express();
const port = process.env.PORT || 11000;

app.use(morgan('dev'));
app.listen(port, () => {
  console.log(`Express app running at http://localhost:${port}`);
});

//
// routes

app.post('/', upload.single('thumb'), async (req, res, next) => {
  const payload = JSON.parse(req.body.payload);
  const isVideo = (payload.Metadata.librarySectionType === 'movie' || payload.Metadata.librarySectionType === 'show');
  const isAudio = (payload.Metadata.librarySectionType === 'artist');
  const key = sha1(payload.Server.uuid + payload.Metadata.ratingKey);

  // missing required properties
  if (!payload.Metadata || !(isAudio || isVideo)) {
    return res.sendStatus(400);
  }

  // retrieve cached image
  let image = await redis.getBuffer(key);

  if (image) {
    console.log('[REDIS]', `Using cached image ${key}`);
  }

  // save new image
  if (isMediaPlay(payload.mediaEvent) || isMediaRate(payload.event)) {
    if (!image && req.file && req.file.buffer) {
      console.log('[REDIS]', `Saving new image ${key}`);
      image = await sharp(req.file.buffer)
        .resize(75, 75)
        .background('white')
        .embed()
        .toBuffer();

      redis.set(key, image, 'EX', SEVEN_DAYS);
    }
  }

  // post to slack
  if (isVideo || isMediaRate(payload.event)) {
    let location = '';
    if (isMediaScrobble(payload.event) && isVideo) {
      // location = await getLocation(payload.Player.publicAddress);
    }

    let action = getAction(payload.event);

    if (isMediaScrobble(payload.event)) {
      // action = 'played';
    } else if (payload.rating > 0) {
      action += ' ';
      for (var i = 0; i < payload.rating / 2; i++) {
        action += ':star:';
      }
    } else {
      // action = 'unrated';
    }

    if (image) {
      console.log('[SLACK]', `Sending ${key} with image`);
      notifySlack(appURL + '/images/' + key, payload, location, action);
    } else {
      console.log('[SLACK]', `Sending ${key} without image`);
      notifySlack(null, payload, location, action);
    }
  }

  res.sendStatus(200);

});

app.get('/images/:key', async (req, res, next) => {
  const exists = await redis.exists(req.params.key);

  if (!exists) {
    return next();
  }

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

app.use((err, req, res, next) => {
  res.status(err.status || 500);
  res.send(err.message);
});

//
// helpers

function getLocation(ip) {
  return request.get(`http://api.ipstack.com/${ip}?access_key=${process.env.IPSTACK_KEY}`, {json: true});
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
    ret = metadata.tagline;
  }

  return ret;
}

function notifySlack(imageUrl, payload, location, action) {
  let locationText = '';

  if (location) {
    const state = location.country_code === 'US' ? location.region_name : location.country_name;
    locationText = `near ${location.city}, ${state}`;
  }

  slack.webhook({
    channel,
    username: 'Plex',
    icon_emoji: ':plex:',
    attachments: [{
      fallback: 'Required plain-text summary of the attachment.',
      color: '#a67a2d',
      title: formatTitle(payload.Metadata),
      text: formatSubtitle(payload.Metadata),
      thumb_url: imageUrl,
      footer: `${action} by ${payload.Account.title} on ${payload.Player.title} from ${payload.Server.title} ${locationText}`,
      footer_icon: payload.Account.thumb
    }]
  }, () => {
  });
}

function isMediaPlay(mediaEvent) {
  return mediaEvent === MEDIA_PLAYING;
}

function isMediaPause(mediaEvent) {
  return mediaEvent === MEDIA_PAUSED;
}

function isMediaResume(mediaEvent) {
  return mediaEvent === MEDIA_RESUMED;
}

function isMediaStop(mediaEvent) {
  return mediaEvent === MEDIA_STOPPED;
}

function isMediaScrobble(mediaEvent) {
  return mediaEvent === MEDIA_VIEWED;
}

// DKTODO: only showing "Season Nr."
function isMediaRate(mediaEvent) {
  return mediaEvent === MEDIA_RATED;
}

function getAction(mediaEvent) {
  let action = 'unkown';
  switch (mediaEvent) {
    case MEDIA_PLAYING:
      action = 'played';
      break;
    case MEDIA_PAUSED:
      action = 'paused';
      break;
    case MEDIA_RESUMED:
      action = 'resumed';
      break;
    case MEDIA_STOPPED:
      action = 'stopped';
      break;
    case MEDIA_VIEWED:
      action = 'viewed';
      break;
    case MEDIA_RATED:
      action = 'rated';
      break;
    default:
      action = 'unkown'
  }

  return action;
}
