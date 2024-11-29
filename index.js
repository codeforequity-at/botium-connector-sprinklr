const fs = require('fs')
const path = require('path')

const PluginClass = require('./src/connector')

const logo = fs.readFileSync(path.join(__dirname, 'logo.png')).toString('base64')

module.exports = {
  PluginVersion: 1,
  PluginClass: PluginClass,
  PluginDesc: {
    name: 'Sprinklr',
    avatar: logo,
    provider: 'Sprinklr',
    features: {
      intentResolution: false,
      entityResolution: false,
      testCaseGeneration: false,
      testCaseExport: false
    },
    capabilities: [
      {
        name: 'SPRINKL_ENVIRONMENT',
        label: 'Environment',
        type: 'choice',
        required: true,
        choices: [
          { name: 'App', key: 'app' },
          { name: 'Prod', key: 'prod' },
          { name: 'Prod0', key: 'prod0' },
          { name: 'Prod2', key: 'prod2' },
          { name: 'Prod3', key: 'prod3' },
          { name: 'Prod4', key: 'prod4' }
        ]
      },
      {
        name: 'SPRINKL_APP_ID',
        label: 'App ID',
        type: 'string',
        required: true
      },
      {
        name: 'SPRINKL_LANDING_PAGE_URL',
        label: 'Landing Page URL',
        type: 'string',
        required: true
      },
      {
        name: 'SPRINKL_TIMEZONE',
        label: 'Timezone',
        description: 'Like "America/New_York"',
        type: 'string',
        advanced: true
      },
      {
        name: 'SPRINKL_RESPONSE_POLL_INTERVAL',
        label: 'Response Poll Interval',
        description: 'In milliseconds. Default is 100',
        type: 'int',
        advanced: true
      },
      {
        name: 'SPRINKL_USER_AGENT',
        label: 'User Agent',
        description: 'See "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/User-Agent"',
        type: 'string',
        advanced: true
      },
      {
        name: 'SPRINKL_FALLBACK_LOCALES',
        label: 'Fallback Locales',
        type: 'string',
        advanced: true
      },
      {
        name: 'SPRINKL_API_KEY',
        label: 'Api key.',
        description: 'Required for using sending Chat User.',
        type: 'secret',
        advanced: true
      },
      {
        name: 'SPRINKL_CHAT_USER',
        label: 'Chat User (userId, firstName, lastName, profileImageUrl, phoneNo, email)',
        type: 'json',
        advanced: true
      }
    ]
  }
}
