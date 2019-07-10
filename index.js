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

// DKTODO: convert console.logs to slack notifications

//
// playback events

const MEDIA_PLAYING = 'media.play';
const MEDIA_PAUSED = 'media.pause';
const MEDIA_RESUMED = 'media.resume';
const MEDIA_STOPPED = 'media.stop';
const MEDIA_VIEWED = 'media.scrobble';
const MEDIA_RATED = 'media.rate';

//
// library events

const LIBRARY_MEDIA_ADDED = 'library.new';
const LIBRARY_MEDIA_ADDED_ON_DECK = 'library.on.deck';

//
// server owner events

const ADMIN_DATABASE_BACKUP = 'admin.database.backup';
const ADMIN_DATABASE_CORRUPTED = 'admin.database.corrupted';
const NEW_DEVICE = 'device.new';
const PLAYBACK_STARTED = 'playback.started';

//
// app config

const appURL = process.env.APP_URL;
const port = process.env.PORT || 11000;
const redisUrl = process.env.REDIS_URL;

//
// slack config

const postToSlack = process.env.POST_TO_SLACK || false;
const anonymizeUserForSlack = process.env.ANONYMIZE_USER_FOR_SLACK || true; // DKTODO: use config
const slackUrl = process.env.SLACK_URL;
const slackChannel = process.env.SLACK_CHANNEL;

//
// discord config

const postToDiscord = process.env.POST_TO_DISCORD || false;
const anonymizeUserForDiscord = process.env.ANONYMIZE_USER_FOR_DISCORD || true; // DKTODO: use config
const discordChannel = process.env.DISCORD_CHANNEL_ID;
const discordToken = process.env.DISCORD_TOKEN;

//
// init slack

const slack = new Slack();
slack.setWebhook(slackUrl);

//
// init discord

const discordClient = new Discord.Client();
discordClient.login(discordToken);

//
// init

const app = express();
const redis = new Redis(redisUrl);

//
// start app

app.use(morgan('dev'));
app.listen(port, () => console.log(`Express app running at http://localhost:${port}`));

//
// routes

//
// main route

app.post('/', upload.single('thumb'), async (req, res, next) => {
    const payload = JSON.parse(req.body.payload);

    const isVideo = isVideo(payload);
    const isMusic = isMusic(payload);
    const key = generateImageKey(payload);

    // missing required properties
    if (!payload.Metadata || !(isMusic || isVideo)) {
        console.error('[APP]', `Missing required properties`);

        // DKTODO: temporary loggint to slack
        slack.webhook(
            {
                slackChannel,
                username: 'Plex',
                icon_emoji: ':plex:',
                attachments: [{
                    color: '#a67a2d',
                    title: 'Debugging',
                    text: req.body.payload
                }]
            },
            () => null
        );

        next(createErrorMessage(400, 'Bad Request'));
        return;
    }

    if (isMediaPause(payload.event) || isMediaStop(payload.event) || isMediaResume(payload.event) || isPlaybackStarted(payload.event)) {
        console.warn('[APP]', `Event type is: "${payload.event}".  Will be ignored.`);

        return res.json(createMessage(200, 'OK'));
    }

    if (
        isNewMediaAdded(payload.event) || isNewMediaAddedOnDeck(payload.event)
        || isNewDeviceAdded(payload.event)
        || isDatabaseBackupCompleted(payload.event) || isDatabaseCorrupted(payload.event)
    ) {
        console.warn('[APP]', `Event type is: "${payload.event}".  Will be ignored for discord.`);

        return res.json(createMessage(200, 'OK'));
    }

    // retrieve cached image
    let image = await redis.getBuffer(key);

    // save new image
    if (!image && req.file && req.file.buffer) {
        console.log('[REDIS]', `Saving new image ${key}`);
        image = await sharp(req.file.buffer)
            .resize(75, 75)
            .background('white')
            .embed()
            .toBuffer();

        redis.set(key, image, 'EX', SEVEN_DAYS);
    } else {
        console.log('[REDIS]', `Using cached image ${key}`);
    }

    let location = '';

    if (isVideo && payload.Player && payload.Player.publicAddress) {
        location = await getLocation(payload.Player.publicAddress);
    }

    const action = getAction(payload);

    // post to slack
    if (postToSlack) {
        if (image) {
            console.log('[SLACK]', `Sending ${key} with image`);
            notifySlack(appURL + '/images/' + key, payload, location, action);
        } else {
            console.log('[SLACK]', `Sending ${key} without image`);
            notifySlack(null, payload, location, action);
        }
    }

    // post to discord
    if (postToDiscord) {
        if (image) {
            console.log('[DISCORD]', `Sending ${key} with image`);
            notifyDiscord(appURL + '/images/' + key, payload, location, action);
        } else {
            console.log('[DISCORD]', `Sending ${key} without image`);
            notifyDiscord(null, payload, location, action);
        }
    }

    return res.json(createMessage(200, 'OK'));
});

//
// image route

app.get('/images/:key', async (req, res, next) => {
    const exists = await redis.exists(req.params.key);

    if (!exists) {
        return next();
    }

    const image = await redis.getBuffer(req.params.key);
    sharp(image).jpeg().pipe(res);
});

//
// ping route

app.get('/ping', async (req, res, next) => {
    return res.json(createMessage(200, 'OK'));
});

//
// error handlers

app.use((req, res, next) => {
    next(createErrorMessage(404, 'Not Found'));
});

app.use((err, req, res, next) => {
    const statusCode = err.status || 500;
    res.status(statusCode);
    res.json(generateErrorResponse(statusCode, err.message));
});

//
// do not let app sleep

setInterval(() => request.get(`${appURL}/ping`), 300000);

//
// helpers

function getLocation(ip) {
    return request.get(`http://api.ipstack.com/${ip}?access_key=${process.env.IPSTACK_KEY}`, {json: true});
}

function formatTitle(metadata) {
    if (metadata.grandparentTitle) {
        return metadata.grandparentTitle;
    }

    let ret = metadata.title;

    if (metadata.year) {
        ret += ` (${metadata.year})`;
    }

    return ret;
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

    // DKTODO: temporary fix
    const title = formatTitle(payload.Metadata);

    slack.webhook(
        {
            slackChannel,
            username: 'Plex',
            icon_emoji: ':plex:',
            attachments: [{
                fallback: `${title} ${action} by ${payload.Account.title}`,
                color: '#a67a2d',
                title: formatTitle(payload.Metadata),
                text: formatSubtitle(payload.Metadata),
                thumb_url: imageUrl,
                footer: `${action} by ${payload.Account.title} on ${payload.Player.title} from ${payload.Server.title} ${locationText}`,
                footer_icon: payload.Account.thumb
            }]
        },
        () => null
    );
}

function notifyDiscord(imageUrl, payload, location, action) {
    let locationText = '';

    if (location) {
        const state = location.country_code === 'US' ? location.region_name : location.country_name;
        locationText = `near ${location.city}, ${state}`;
    }

    discordClient.channels.get(discordChannel).send({
        embed: {
            color: 3447003,
            title: formatTitle(payload.Metadata),
            description: formatSubtitle(payload.Metadata),
            timestamp: new Date(),
            footer: {
                icon_url: 'https://dl2.macupdate.com/images/icons256/42311.png?d=1535042731',
                text: `${action} from ${payload.Server.title} ${locationText}`
            }
        }
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

function isNewMediaAdded(mediaEvent) {
    return mediaEvent === LIBRARY_MEDIA_ADDED;
}

function isNewMediaAddedOnDeck(mediaEvent) {
    return mediaEvent === LIBRARY_MEDIA_ADDED_ON_DECK;
}

function isDatabaseBackupCompleted(mediaEvent) {
    return mediaEvent === ADMIN_DATABASE_BACKUP;
}

function isDatabaseCorrupted(mediaEvent) {
    return mediaEvent === ADMIN_DATABASE_CORRUPTED;
}

function isNewDeviceAdded(mediaEvent) {
    return mediaEvent === NEW_DEVICE;
}

function isPlaybackStarted(mediaEvent) {
    return mediaEvent === PLAYBACK_STARTED;
}

function getAction(payload) {
    switch (payload.event) {
        case MEDIA_PLAYING:
            return 'playing';

        case MEDIA_PAUSED:
            return 'paused';

        case MEDIA_RESUMED:
            return 'resumed';

        case MEDIA_STOPPED:
            return 'stopped';

        case MEDIA_VIEWED:
            return 'viewed';

        case MEDIA_RATED:
            return getValueForMediaRated(payload);

        default:
            console.error('[APP]', `Unknown event: "${payload.event}"`);
            return 'unknown';
    }
}

function getValueForMediaRated(payload) {
    let ratedAction = 'rated';

    if (payload.rating > 0) {
        ratedAction += ' ';
        for (let i = 0; i < payload.rating / 2; i++) {
            ratedAction += ':star:';
        }
    }

    return ratedAction;
}

function isVideo(payload) {
    return payload.Metadata.librarySectionType === 'movie' || payload.Metadata.librarySectionType === 'show';
}

function isMusic(payload) {
    return payload.Metadata.librarySectionType === 'artist';
}

function generateImageKey(payload) {
    sha1(payload.Server.uuid + payload.Metadata.ratingKey);
}

function generateErrorResponse(statusCode, message) {
    return {
        errors: [
            {
                status: statusCode,
                message: message,
            }
        ]
    };
}

function createErrorMessage(statusCode, message) {
    const err = new Error(message);
    err.status = statusCode;

    return err;
}

function createMessage(statusCode, message) {
    return {status: statusCode, message: message};
}
