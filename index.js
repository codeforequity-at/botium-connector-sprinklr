const PluginVersion = require('./package.json').version
const PluginClass = require('./src/connector')

module.exports = {
  PluginVersion,
  PluginClass,
  PluginDesc: {
    name: 'Sprinklr (Live Chat / NLP Testing)',
    avatar: 'https://miro.medium.com/v2/resize:fit:600/1*6VXNsFjNGaL-YPr8LU88cg.png',
    provider: 'Sprinklr',
    features: {
      intentResolution: true,
      intentConfidenceScore: true,
      alternateIntents: true
    },
    capabilities: [
      // ============================================
      // 📌 MODE SELECTION (REQUIRED)
      // ============================================
      {
        name: 'SPRINKL_MODE',
        label: 'Connector Mode',
        description: 'Select the mode: "Live Chat" for real-time conversations, "NLP Testing" for Source-Agnostic API bot testing',
        type: 'choice',
        required: true,
        choices: [
          { key: 'LIVE_CHAT', name: 'Live Chat' },
          { key: 'NLP_TESTING', name: 'NLP Testing' }
        ]
      },

      // ============================================
      // 🔵 LIVE CHAT MODE CAPABILITIES
      // ============================================
      {
        name: 'SPRINKL_ENVIRONMENT',
        label: '[Live Chat] Environment',
        description: 'Required for Live Chat mode',
        type: 'choice',
        required: false,
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
        label: '[Live Chat] App ID',
        description: 'Required for Live Chat mode',
        type: 'string',
        required: false
      },
      {
        name: 'SPRINKL_LANDING_PAGE_URL',
        label: '[Live Chat] Landing Page URL',
        description: 'Required for Live Chat mode',
        type: 'string',
        required: false
      },
      {
        name: 'SPRINKL_API_KEY',
        label: '[Live Chat] API Key',
        description: 'Optional - Required for using sending Chat User',
        type: 'secret',
        required: false,
        advanced: true
      },
      {
        name: 'SPRINKL_CHAT_USER',
        label: '[Live Chat] Chat User',
        description: 'Optional - JSON with userId, firstName, lastName, profileImageUrl, phoneNo, email',
        type: 'json',
        required: false,
        advanced: true
      },
      {
        name: 'SPRINKL_CUSTOM_CONTEXT',
        label: '[Live Chat] Custom Context',
        description: 'Optional - Key-value pairs for profile custom field names and corresponding values',
        type: 'json',
        required: false,
        advanced: true
      },
      {
        name: 'SPRINKL_STARTED_BY_CONTEXT',
        label: '[Live Chat] Started By Context',
        description: 'Optional - Key-value pairs for case custom field name and corresponding value',
        type: 'json',
        required: false,
        advanced: true
      },

      // ============================================
      // 🟢 NLP TESTING MODE (SOURCE-AGNOSTIC API)
      // ============================================
      {
        name: 'SPRINKL_SA_ACCOUNT_ID',
        label: '[NLP] Account ID',
        description: 'Required - Your Sprinklr account ID (e.g., 300289798)',
        type: 'string',
        required: false
      },
      {
        name: 'SPRINKL_SA_CLIENT_ID',
        label: '[NLP] OAuth Client ID',
        description: 'Required - OAuth 2.0 client ID from Sprinklr Developer Portal',
        type: 'string',
        required: false
      },
      {
        name: 'SPRINKL_SA_CLIENT_SECRET',
        label: '[NLP] OAuth Client Secret',
        description: 'Required - OAuth 2.0 client secret (token fetched automatically)',
        type: 'secret',
        required: false
      },
      {
        name: 'SPRINKL_SA_ENVIRONMENT',
        label: '[NLP] Environment',
        description: 'Required - Sprinklr environment (determines API endpoint)',
        type: 'choice',
        required: false,
        choices: [
          { name: 'Prod3', key: 'prod3' },
          { name: 'Prod2', key: 'prod2' },
          { name: 'Prod', key: 'prod' },
          { name: 'Prod0', key: 'prod0' }
        ]
      },
      {
        name: 'SPRINKL_SA_SENDER_PROFILE',
        label: '[NLP] Sender Profile',
        description: 'Required - JSON with sender id. Example: {"id": "botium_sender_123"}',
        type: 'json',
        required: false
      },
      {
        name: 'SPRINKL_SA_RECEIVER_PROFILE',
        label: '[NLP] Receiver Profile',
        description: 'Required - JSON with receiver id. Example: {"id": "botium_receiver_456"}',
        type: 'json',
        required: false
      },
      {
        name: 'SPRINKL_SA_INTENT_FIELD_MAPPING',
        label: '[NLP] Intent Custom Field ID',
        description: 'Optional - Custom field ID to extract intents from (e.g., "_c_6a8d564990b44d451cc190c1")',
        type: 'string',
        required: false,
        advanced: true
      },

      // ============================================
      // ⚙️ COMMON CAPABILITIES (OPTIONAL)
      // ============================================
      {
        name: 'SPRINKL_TIMEZONE',
        label: 'Timezone',
        description: 'Optional - Timezone for timestamps (e.g., "America/New_York")',
        type: 'string',
        required: false,
        advanced: true
      },
      {
        name: 'SPRINKL_RESPONSE_POLL_INTERVAL',
        label: 'Response Poll Interval (ms)',
        description: 'Optional - How often to check for responses in Live Chat mode (default: 100ms)',
        type: 'int',
        required: false,
        advanced: true
      },
      {
        name: 'SPRINKL_USER_AGENT',
        label: 'User Agent',
        description: 'Optional - Custom User-Agent header for API requests',
        type: 'string',
        required: false,
        advanced: true
      },
      {
        name: 'SPRINKL_FALLBACK_LOCALES',
        label: 'Fallback Locales',
        description: 'Optional - Comma-separated list of fallback locales',
        type: 'string',
        required: false,
        advanced: true
      },

      // ============================================
      // 🔴 REDIS INBOUND (INJECTED BY BOTIUM BOX)
      // ============================================
      {
        name: 'SIMPLEREST_INBOUND_REDISURL',
        label: 'Redis URL',
        description: 'Redis connection URL for webhook processing (auto-injected by Botium Box)',
        type: 'string',
        required: false,
        advanced: true
      },
      {
        name: 'SIMPLEREST_REDIS_TOPIC',
        label: 'Redis Topic',
        description: 'Redis topic for inbound webhook messages (default: botium-inbound-sprinklr)',
        type: 'string',
        required: false,
        advanced: true
      }
    ]
  }
}
