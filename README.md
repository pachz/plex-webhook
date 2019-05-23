#plex-webhook

In order to run this app: 
- Install [node.js](https://nodejs.org/en/).
- Install [yarn](https://yarnpkg.com/en/docs/install).
- Sign up for a free [ipstack API key](https://ipstack.com/signup/free).
- Clone the repository.
- Install dependencies using `yarn`.
- Make a new app at Heroku, and add the Heroku Redis add-on (free plan) and note the app URL.
- Add a config var APP_URL (usually {app_name}.herokuapp.com)
- Make a Slack webhook for a slack-channel and note the URL, add them as config vars named SLACK_URL & SLACK_CHANNEL.
- Make a Discord bot add the config vars named DISCORD_CHANNEL_ID & DISCORD_TOKEN.
- Deploy to Heroku.
- Have anyone who wants to contribute add the webhook on https://app.plex.tv/web/app#!/account/webhooks

Alternatively, deploy straight to Heroku now:

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)
You'll be asked to complete these config vars
```dotenv
APP_URL                         # URL of this app
IPSTACK_KEY                     # API key from ipstack.com
REDIS_URL                       # The URL of redis (will be configured automatically)
SLACK_URL                       # URL of Slack WebHook
SLACK_CHANNEL                   # Channel name of Slack [#channel-name]
DISCORD_CHANNEL_ID              # Channel ID of Discord
DISCORD_TOKEN                   # Token to access Discord
POST_TO_DISCORD                 # Defines if the app can post to discord [bool]]
POST_TO_SLACK                   # Defines if the app can post to slack [bool]
ANONYMIZE_USER_FOR_DISCORD      # Defines if the post should be anonymize the plex user-name [bool]
ANONYMIZE_USER_FOR_SLACK        # Defines if the post should be anonymize the plex user-name [bool]
```
