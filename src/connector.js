const util = require('util')
const debug = require('debug')('botium-connector-sprinkl')
const crypto = require('crypto')

const Capabilities = require('./Capabilities')
const _ = require('lodash')

class BotiumConnectorSprinkl {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps

    // Live Chat mode state
    this.chatSessionToken = null
    this.userId = null
    this.conversationId = null
    this.pollingEnabled = false
    // Why semaphore?:
    // me: hello bot
    // bot: hello human
    // http response to "hello bot" can come after "hello human" message.
    // But for keeping the order of messages, we need to wait for the response of "hello bot" message.
    this.messageSendingSemaphorePromise = null
    this.messageSendingSemaphorePromiseResolve = null
    this.handledMessages = null

    // NLP Testing mode state (Source-Agnostic API)
    this.mode = null
    this.redis = null
    this.redisTopic = null
    this.processInbound = false
    this.saAccountId = null
    this.saEnvironment = null
    this.saAuthToken = null
    this.saTokenExpiresAt = null
    this.saRefreshToken = null
    this.saConversationId = null
    this.saCaseNumber = null // Track case number from API response
    this.saPendingMessages = new Map() // Map messageId to expected case
  }

  _getMode () {
    return this.caps[Capabilities.SPRINKL_MODE] || 'LIVE_CHAT'
  }

  _isLiveChatMode () {
    return this._getMode() === 'LIVE_CHAT'
  }

  _isNlpTestingMode () {
    return this._getMode() === 'NLP_TESTING'
  }

  _getSAEnvironment () {
    return this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT] || 'prod3'
  }

  // ============================================================================
  // NLP TESTING MODE - OAUTH METHODS
  // ============================================================================

  async _fetchSAToken () {
    // Build token URL with environment
    const environment = this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT] || 'prod3'
    const tokenUrl = `https://api3.sprinklr.com/${environment}/oauth/token`
    const maskedClientId = this.caps[Capabilities.SPRINKL_SA_CLIENT_ID]?.substring(0, 8) + '...'

    debug('━'.repeat(70))
    debug('🔐 FETCHING OAUTH TOKEN (Client Credentials)')
    debug('━'.repeat(70))
    debug(`   URL: ${tokenUrl}`)
    debug('   Grant Type: client_credentials')
    debug(`   Client ID: ${maskedClientId}`)
    debug('   Client Secret: ********')

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.caps[Capabilities.SPRINKL_SA_CLIENT_ID],
      client_secret: this.caps[Capabilities.SPRINKL_SA_CLIENT_SECRET]
    })

    debug('   📤 Sending authentication request...')
    const startTime = Date.now()

    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })

      const elapsed = Date.now() - startTime
      debug(`   ⏱️  Response received in ${elapsed}ms`)

      if (!response.ok) {
        const errorText = await response.text()
        debug('   ❌ AUTHENTICATION FAILED')
        debug(`   Status: ${response.status} ${response.statusText}`)
        debug(`   Error: ${errorText}`)
        debug('━'.repeat(70))
        throw new Error(`SA OAuth token fetch failed: ${response.status}/${response.statusText} - ${errorText}`)
      }

      const data = await response.json()
      debug('   ✅ AUTHENTICATION SUCCESSFUL!')
      debug(`   Access Token: ${data.access_token ? data.access_token.substring(0, 20) + '...' : 'N/A'}`)
      debug(`   Token Type: ${data.token_type || 'N/A'}`)
      debug(`   Expires In: ${data.expires_in || 'N/A'} seconds`)
      debug(`   Has Refresh Token: ${data.refresh_token ? 'Yes' : 'No'}`)

      this._storeSAToken(data)

      debug('━'.repeat(70))
      debug('✅ OAuth token acquired via client_credentials')
      debug('━'.repeat(70))
    } catch (err) {
      debug('   ❌ FETCH ERROR:', err.message)
      debug('━'.repeat(70))
      throw err
    }
  }

  async _refreshSAToken () {
    const environment = this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT] || 'prod3'
    const tokenUrl = `https://api3.sprinklr.com/${environment}/oauth/token`

    debug('━'.repeat(70))
    debug('🔄 REFRESHING OAUTH TOKEN')
    debug('━'.repeat(70))
    debug(`   URL: ${tokenUrl}`)
    debug('   Grant Type: refresh_token')
    debug(`   Has Refresh Token: ${this.saRefreshToken ? 'Yes' : 'No'}`)

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.caps[Capabilities.SPRINKL_SA_CLIENT_ID],
      client_secret: this.caps[Capabilities.SPRINKL_SA_CLIENT_SECRET],
      refresh_token: this.saRefreshToken
    })

    debug('   📤 Sending refresh request...')
    const startTime = Date.now()

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })

    const elapsed = Date.now() - startTime
    debug(`   ⏱️  Response received in ${elapsed}ms`)

    if (!response.ok) {
      debug(`   ⚠️  Refresh failed (${response.status}), falling back to client_credentials`)
      debug('━'.repeat(70))
      await this._fetchSAToken()
      return
    }

    const data = await response.json()
    debug('   ✅ TOKEN REFRESHED SUCCESSFULLY!')
    debug(`   New Access Token: ${data.access_token ? data.access_token.substring(0, 20) + '...' : 'N/A'}`)
    debug(`   Expires In: ${data.expires_in || 'N/A'} seconds`)

    this._storeSAToken(data)

    debug('━'.repeat(70))
    debug('✅ OAuth token refreshed')
    debug('━'.repeat(70))
  }

  _storeSAToken (data) {
    this.saAuthToken = data.access_token
    this.saRefreshToken = data.refresh_token || this.saRefreshToken
    // Expire 60 seconds early to avoid edge-case expiry mid-request
    this.saTokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000

    const expiryDate = new Date(this.saTokenExpiresAt)
    const secondsUntilExpiry = Math.floor((this.saTokenExpiresAt - Date.now()) / 1000)

    debug('💾 TOKEN STORED')
    debug(`   Access Token: ${this.saAuthToken ? this.saAuthToken.substring(0, 20) + '...' : 'N/A'}`)
    debug(`   Refresh Token: ${this.saRefreshToken ? 'Present' : 'Not present'}`)
    debug(`   Expires At: ${expiryDate.toISOString()}`)
    debug(`   Valid For: ${secondsUntilExpiry} seconds (${Math.floor(secondsUntilExpiry / 60)} minutes)`)
  }

  async _ensureSAToken () {
    const now = Date.now()
    const hasToken = !!this.saAuthToken
    const isExpired = hasToken && now >= this.saTokenExpiresAt
    const secondsRemaining = hasToken && !isExpired ? Math.floor((this.saTokenExpiresAt - now) / 1000) : 0

    debug('🔍 Checking token validity...')
    debug(`   Has Token: ${hasToken ? 'Yes' : 'No'}`)

    if (hasToken) {
      debug(`   Is Expired: ${isExpired ? 'Yes' : 'No'}`)
      debug(`   Time Remaining: ${secondsRemaining} seconds`)
    }

    if (!this.saAuthToken || Date.now() >= this.saTokenExpiresAt) {
      if (this.saRefreshToken && this.saAuthToken) {
        debug('   ⚠️  Token expired, refreshing...')
        await this._refreshSAToken()
      } else {
        debug('   ⚠️  No token available, fetching new token...')
        await this._fetchSAToken()
      }
    } else {
      debug(`   ✅ Token still valid (${secondsRemaining}s remaining)`)
    }
  }

  // ============================================================================
  // NLP TESTING MODE - WEBHOOK PROCESSING
  // ============================================================================

  _extractIntentFromWebhook (customProperties) {
    debug('_extractIntentFromWebhook called with customProperties:', JSON.stringify(customProperties, null, 2))

    const nlp = { intents: [] }

    // First, check for custom field ID provided by user
    const intentFieldId = this.caps[Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]
    if (intentFieldId) {
      debug(`Checking custom field for intents: ${intentFieldId}`)
      const intentArray = customProperties[intentFieldId]
      if (intentArray && Array.isArray(intentArray) && intentArray.length > 0) {
        intentArray.forEach(intentName => {
          nlp.intents.push({
            name: intentName,
            confidence: 1.0
          })
          debug(`  ✅ Extracted intent from custom field: ${intentName}`)
        })
      } else {
        debug(`  ⚠️  Custom field ${intentFieldId} not found or empty`)
      }
    }

    // If no intents extracted from custom field, check triggered issue types
    if (nlp.intents.length === 0) {
      const triggeredIssues = customProperties.spr_triggered_issue_types || []
      triggeredIssues.forEach(issue => {
        nlp.intents.push({ name: issue, confidence: 1.0 })
        debug(`  ✅ Added triggered issue type: ${issue}`)
      })
    }

    // If still no intents, check detected issue types (fallback)
    if (nlp.intents.length === 0) {
      const detectedIssues = customProperties.spr_detected_issue_types || []
      detectedIssues.forEach(issue => {
        nlp.intents.push({ name: issue, confidence: 0.9 })
        debug(`  ✅ Added detected issue type: ${issue}`)
      })
    }

    // Set primary intent (first one with highest confidence)
    if (nlp.intents.length > 0) {
      nlp.intents.sort((a, b) => b.confidence - a.confidence)
      nlp.intent = nlp.intents[0]
      debug(`Primary intent selected: "${nlp.intent.name}" (confidence: ${nlp.intent.confidence})`)
    } else {
      debug('No intents extracted from webhook')
    }

    return Object.keys(nlp).length > 0 && nlp.intents.length > 0 ? nlp : null
  }

  _processInboundEvent (event) {
    if (!this.processInbound) {
      debug('_processInboundEvent: processInbound=false, skipping')
      return
    }

    const body = event.body
    if (!body) {
      debug('_processInboundEvent: no body in event')
      return
    }

    debug(`_processInboundEvent: received event type: ${body.type}`)

    if (body.type !== 'case.update') {
      debug(`_processInboundEvent: ignoring event type ${body.type}`)
      return
    }

    const payload = body.payload
    if (!payload) {
      debug('_processInboundEvent: no payload in event body')
      return
    }

    // PRIMARY MATCHING: Match by caseNumber
    const inboundCaseNumber = payload.caseNumber
    if (!inboundCaseNumber) {
      debug('_processInboundEvent: no caseNumber in webhook payload')
      return
    }

    debug('🔍 Matching webhook response:')
    debug(`   Inbound Case Number: ${inboundCaseNumber}`)
    debug(`   Expected Case Number: ${this.saCaseNumber}`)

    if (inboundCaseNumber !== this.saCaseNumber) {
      debug('   ❌ Case number mismatch - ignoring this webhook')
      return
    }

    debug('   ✅ Case number matched!')

    // SECONDARY MATCHING: Verify conversationId for extra safety
    const inboundConvId = payload.externalCase?.id || payload.conversationId
    if (inboundConvId) {
      debug(`   Conversation ID: ${inboundConvId}`)
      if (this.saConversationId && inboundConvId !== this.saConversationId) {
        debug(`   ⚠️  Conversation ID mismatch (expected: ${this.saConversationId}, got: ${inboundConvId})`)
        debug('   ⚠️  But case number matches, so proceeding...')
      } else {
        debug('   ✅ Conversation ID also matched!')
      }
    }

    // Extract message from case description or subject
    const messageText = payload.description || payload.subject || ''
    debug(`   Message text: "${messageText}"`)

    // Build bot message
    const botMsg = {
      sender: 'bot',
      messageText: messageText,
      sourceData: body
    }

    // Extract intent from custom properties
    const customProps = payload.workflow?.customProperties || {}
    if (Object.keys(customProps).length > 0) {
      debug('   Custom properties found:', JSON.stringify(customProps, null, 2))
      botMsg.nlp = this._extractIntentFromWebhook(customProps)
      if (botMsg.nlp) {
        debug(`   ✅ Intent extracted: ${botMsg.nlp.intent?.name} (confidence: ${botMsg.nlp.intent?.confidence})`)
      } else {
        debug('   ⚠️  No intent extracted from custom properties')
      }
    } else {
      debug('   ⚠️  No custom properties found in webhook payload')
    }

    debug('✅ Inbound bot message ready:', JSON.stringify(botMsg, null, 2))
    setTimeout(() => this.queueBotSays(botMsg), 0)
  }

  // ============================================================================
  // BUILD - REDIS SETUP FOR NLP TESTING MODE
  // ============================================================================

  async Build () {
    debug('Build called')
    this.mode = this._getMode()
    debug(`Connector mode: ${this.mode}`)

    if (this._isNlpTestingMode()) {
      // Validate Redis URL from Botium Box
      if (!this.caps[Capabilities.SIMPLEREST_INBOUND_REDISURL]) {
        throw new Error(
          'SIMPLEREST_INBOUND_REDISURL capability is required for NLP_TESTING mode. ' +
          'This is automatically injected by Botium Box. ' +
          'If running standalone (botium-cli), add it to your botium.json: ' +
          '"SIMPLEREST_INBOUND_REDISURL": "redis://127.0.0.1:6379"'
        )
      }

      // Setup Redis subscription
      const redisUrl = this.caps[Capabilities.SIMPLEREST_INBOUND_REDISURL]
      const Redis = (await import('ioredis')).default
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) return null
          return Math.min(times * 200, 1000)
        },
        lazyConnect: true
      })

      this.redisTopic = this.caps[Capabilities.SIMPLEREST_REDIS_TOPIC] || 'botium-inbound-sprinklr'

      // Prevent Node from crashing on unhandled Redis error events
      this.redis.on('error', (err) => {
        debug(`Redis connection error: ${err.message}`)
      })

      // Subscribe to inbound events
      this.redis.on('message', (channel, message) => {
        try {
          const event = JSON.parse(message)
          this._processInboundEvent(event)
        } catch (err) {
          debug(`Error parsing inbound Redis message: ${err.message}`)
        }
      })

      // Verify Redis is reachable during Build
      try {
        await this.redis.connect()
        debug('Redis connection verified during Build')
      } catch (err) {
        throw new Error(`Failed to connect to Redis at ${redisUrl}: ${err.message}`)
      }
    }
    // Live Chat mode needs no Build()
  }

  // ============================================================================
  // VALIDATE - MODE-SPECIFIC VALIDATION
  // ============================================================================

  async Validate () {
    debug('Validate called')

    if (this._isNlpTestingMode()) {
      debug('='.repeat(70))
      debug('🔍 VALIDATING NLP TESTING MODE CONFIGURATION')
      debug('='.repeat(70))

      // Track missing capabilities
      const missingCaps = []
      const providedCaps = []

      // Validate NLP testing capabilities
      debug('1️⃣  Checking Account ID...')
      if (!this.caps[Capabilities.SPRINKL_SA_ACCOUNT_ID]) {
        missingCaps.push('SPRINKL_SA_ACCOUNT_ID')
        debug('   ❌ SPRINKL_SA_ACCOUNT_ID is missing')
        throw new Error('SPRINKL_SA_ACCOUNT_ID capability required for NLP_TESTING mode')
      } else {
        providedCaps.push('SPRINKL_SA_ACCOUNT_ID')
        debug(`   ✅ Account ID: ${this.caps[Capabilities.SPRINKL_SA_ACCOUNT_ID]}`)
      }

      // OAuth 2.0 Client Credentials validation
      debug('2️⃣  Checking OAuth Credentials...')
      if (!this.caps[Capabilities.SPRINKL_SA_CLIENT_ID]) {
        missingCaps.push('SPRINKL_SA_CLIENT_ID')
        debug('   ❌ SPRINKL_SA_CLIENT_ID is missing')
        throw new Error('SPRINKL_SA_CLIENT_ID capability required for NLP Testing mode (OAuth 2.0)')
      } else {
        providedCaps.push('SPRINKL_SA_CLIENT_ID')
        const maskedClientId = this.caps[Capabilities.SPRINKL_SA_CLIENT_ID].substring(0, 8) + '...'
        debug(`   ✅ Client ID: ${maskedClientId}`)
      }

      if (!this.caps[Capabilities.SPRINKL_SA_CLIENT_SECRET]) {
        missingCaps.push('SPRINKL_SA_CLIENT_SECRET')
        debug('   ❌ SPRINKL_SA_CLIENT_SECRET is missing')
        throw new Error('SPRINKL_SA_CLIENT_SECRET capability required for NLP Testing mode (OAuth 2.0)')
      } else {
        providedCaps.push('SPRINKL_SA_CLIENT_SECRET')
        debug('   ✅ Client Secret: ********')
      }

      debug('3️⃣  Checking Environment...')
      if (!this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT]) {
        missingCaps.push('SPRINKL_SA_ENVIRONMENT')
        debug('   ❌ SPRINKL_SA_ENVIRONMENT is missing')
        throw new Error('SPRINKL_SA_ENVIRONMENT capability required for NLP Testing mode')
      } else {
        providedCaps.push('SPRINKL_SA_ENVIRONMENT')
        debug(`   ✅ Environment: ${this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT]}`)
      }

      // Validate sender and receiver profiles
      debug('4️⃣  Checking Sender Profile...')
      if (!this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE]) {
        missingCaps.push('SPRINKL_SA_SENDER_PROFILE')
        debug('   ❌ SPRINKL_SA_SENDER_PROFILE is missing')
        throw new Error('SPRINKL_SA_SENDER_PROFILE capability required for NLP Testing mode')
      } else {
        providedCaps.push('SPRINKL_SA_SENDER_PROFILE')
        try {
          // Parse and validate sender profile
          const senderProfile = _.isString(this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE])
            ? JSON.parse(this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE])
            : this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE]
          if (!senderProfile || !senderProfile.id) {
            debug('   ❌ Sender profile missing required "id" field')
            throw new Error('SPRINKL_SA_SENDER_PROFILE must have an "id" field')
          }
          debug(`   ✅ Sender Profile ID: ${senderProfile.id}`)
        } catch (err) {
          debug(`   ❌ Sender profile validation failed: ${err.message}`)
          throw err
        }
      }

      debug('5️⃣  Checking Receiver Profile...')
      if (!this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE]) {
        missingCaps.push('SPRINKL_SA_RECEIVER_PROFILE')
        debug('   ❌ SPRINKL_SA_RECEIVER_PROFILE is missing')
        throw new Error('SPRINKL_SA_RECEIVER_PROFILE capability required for NLP Testing mode')
      } else {
        providedCaps.push('SPRINKL_SA_RECEIVER_PROFILE')
        try {
          // Parse and validate receiver profile
          const receiverProfile = _.isString(this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE])
            ? JSON.parse(this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE])
            : this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE]
          if (!receiverProfile || !receiverProfile.id) {
            debug('   ❌ Receiver profile missing required "id" field')
            throw new Error('SPRINKL_SA_RECEIVER_PROFILE must have an "id" field')
          }
          debug(`   ✅ Receiver Profile ID: ${receiverProfile.id}`)
        } catch (err) {
          debug(`   ❌ Receiver profile validation failed: ${err.message}`)
          throw err
        }
      }

      // Validate OAuth credentials by fetching a token
      debug('6️⃣  Testing OAuth Authentication...')
      debug(`   🔐 Token URL: https://api3.sprinklr.com/${this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT] || 'prod3'}/oauth/token`)
      debug('   🔐 Grant Type: client_credentials')
      try {
        await this._fetchSAToken()
        debug('   ✅ OAuth token acquired successfully!')
        debug(`   ✅ Token expires in: ${this.saTokenExpiresAt ? Math.floor((this.saTokenExpiresAt - Date.now()) / 1000) + ' seconds' : 'unknown'}`)
      } catch (err) {
        debug(`   ❌ OAuth authentication FAILED: ${err.message}`)
        throw new Error(`SA OAuth credential validation failed: ${err.message}`)
      }

      debug('='.repeat(70))
      debug('✅ ALL VALIDATIONS PASSED - NLP Testing Mode Ready')
      debug(`   Provided capabilities: ${providedCaps.length}/6`)
      debug(`   Missing capabilities: ${missingCaps.length}`)
      debug('='.repeat(70))
    } else {
      // Live Chat mode validation (ORIGINAL API)
      debug('🔍 VALIDATING LIVE CHAT MODE CONFIGURATION')

      if (!this.caps[Capabilities.SPRINKL_ENVIRONMENT]) {
        throw new Error('SPRINKL_ENVIRONMENT capability required for LIVE_CHAT mode')
      }
      if (!this.caps[Capabilities.SPRINKL_APP_ID]) {
        throw new Error('SPRINKL_APP_ID capability required for LIVE_CHAT mode')
      }
      if (!this.caps[Capabilities.SPRINKL_LANDING_PAGE_URL]) {
        throw new Error('SPRINKL_LANDING_PAGE_URL capability required for LIVE_CHAT mode')
      }
      if (this.caps[Capabilities.SPRINKL_CHAT_USER] && !this.caps[Capabilities.SPRINKL_API_KEY]) {
        throw new Error('SPRINKL_API_KEY capability required when SPRINKL_CHAT_USER is provided')
      }

      debug('✅ LIVE_CHAT mode validation successful')
    }
  }

  // ============================================================================
  // START - MODE-SPECIFIC INITIALIZATION
  // ============================================================================

  async Start () {
    debug('Start called')

    if (this._isNlpTestingMode()) {
      // NLP Testing mode initialization - OAuth only
      this.saAccountId = this.caps[Capabilities.SPRINKL_SA_ACCOUNT_ID]
      this.saEnvironment = this._getSAEnvironment()

      // Fetch OAuth token automatically
      await this._ensureSAToken()
      debug(`OAuth token acquired for NLP Testing (environment: ${this.saEnvironment})`)

      // Auto-generate conversation ID
      this.saConversationId = `case_${crypto.randomBytes(16).toString('hex')}`
      this.saCaseNumber = null // Will be set after first message
      this.saPendingMessages.clear()

      debug(`NLP Testing mode initialized: accountId=${this.saAccountId}, conversationId=${this.saConversationId}, environment=${this.saEnvironment}`)

      // Enable inbound processing
      if (this.redis) {
        await this.redis.subscribe(this.redisTopic)
        this.processInbound = true
        debug(`Redis subscribed to ${this.redisTopic}, conversation: ${this.saConversationId}`)
      } else {
        debug('Warning: Redis not initialized in NLP_TESTING mode')
      }

      return
    }

    // ============================================================================
    // LIVE CHAT MODE - ORIGINAL API
    // ============================================================================

    this.handledMessages = new Set()

    // Step 1: Handshake
    try {
      const url = `https://${this.caps[Capabilities.SPRINKL_ENVIRONMENT]}-live-chat.sprinklr.com/api/livechat/v1/handshake/appHandshake`

      const body = {
        appId: this.caps[Capabilities.SPRINKL_APP_ID],
        page: this.caps[Capabilities.SPRINKL_LANDING_PAGE_URL],
        timezone: this.caps[Capabilities.SPRINKL_TIMEZONE] || 'America/New_York',
        userAgent: this.caps[Capabilities.SPRINKL_USER_AGENT] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
      }

      if (this.caps[Capabilities.SPRINKL_FALLBACK_LOCALES]) {
        body.fallbackLocales = this.caps[Capabilities.SPRINKL_FALLBACK_LOCALES]
      }

      if (this.caps[Capabilities.SPRINKL_CHAT_USER]) {
        const u = _.isString(this.caps[Capabilities.SPRINKL_CHAT_USER])
          ? JSON.parse(this.caps[Capabilities.SPRINKL_CHAT_USER])
          : this.caps[Capabilities.SPRINKL_CHAT_USER]
        const hmac = crypto.createHmac('sha256', Buffer.from(this.caps[Capabilities.SPRINKL_API_KEY], 'utf8'))
        body.chatUser = 'userId_firstName_lastName_profileImageUrl_phoneNo_email'.split('_').map(e => u[e] || '').join('_')
        hmac.update(Buffer.from(body.chatUser, 'utf8'))
        body.chatUserSignature = hmac.digest('hex')
      }

      if (this.caps[Capabilities.SPRINKL_CUSTOM_CONTEXT]) {
        body.customContext = _.isString(this.caps[Capabilities.SPRINKL_CUSTOM_CONTEXT])
          ? JSON.parse(this.caps[Capabilities.SPRINKL_CUSTOM_CONTEXT])
          : this.caps[Capabilities.SPRINKL_CUSTOM_CONTEXT]
      }

      const options = {
        method: 'POST',
        headers: {
          origin: this.caps[Capabilities.SPRINKL_LANDING_PAGE_URL],
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      }

      debug(`Start.handshake requestOptions ${JSON.stringify({ url, options }, null, 2)}`)
      const response = await fetch(url, options)
      if (!response.ok) {
        throw new Error(`Failed to do handshake: ${response.status}/${response.statusText}`)
      }
      const appHandshake = await response.json()
      this.chatSessionToken = appHandshake.chatSessionToken
      this.userId = appHandshake?.chatUser?.userId || appHandshake.anonymousId
      debug(`Start.handshake successful. chatSessionToken: "${this.chatSessionToken}. userId: "${this.userId}"`)
    } catch (err) {
      throw new Error(`Failed to do handshake: ${err.message}`)
    }

    // Step 2: Create new conversation
    try {
      const url = `https://${this.caps[Capabilities.SPRINKL_ENVIRONMENT].toLowerCase()}-live-chat.sprinklr.com/api/livechat/v1/conversation/new`

      const body = {
        appId: this.caps[Capabilities.SPRINKL_APP_ID]
      }

      if (this.caps[Capabilities.SPRINKL_STARTED_BY_CONTEXT]) {
        body.startedByContext = _.isString(this.caps[Capabilities.SPRINKL_STARTED_BY_CONTEXT])
          ? JSON.parse(this.caps[Capabilities.SPRINKL_STARTED_BY_CONTEXT])
          : this.caps[Capabilities.SPRINKL_STARTED_BY_CONTEXT]
      }

      const options = {
        method: 'POST',
        headers: {
          'x-chat-token': this.chatSessionToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      }

      debug(`Start.newconvo requestOptions ${JSON.stringify({ url, options }, null, 2)}`)
      const response = await fetch(url, options)
      if (!response.ok) {
        throw new Error(`Failed to create convo: ${response.status}/${response.statusText}`)
      }
      const conversation = await response.json()
      this.conversationId = conversation.id

      debug(`Start.newconvo successful. conversationId: "${this.conversationId}"`)

      // Step 3: Start polling for messages
      const _poll = async (cursor) => {
        const url = `https://${this.caps[Capabilities.SPRINKL_ENVIRONMENT]}-live-chat.sprinklr.com/api/livechat/v1/event/fetch-notifications?size=1000`

        const options = {
          method: 'GET',
          headers: {
            'x-chat-token': this.chatSessionToken,
            'content-type': 'application/json'
          }
        }

        let notifications
        try {
          try {
            const response = await fetch(url, options)
            if (!response.ok) {
              throw new Error(`Failed to send message: ${response.status}/${response.statusText}`)
            }
            notifications = await response.json()
          } catch (err) {
            throw new Error(`Failed to fetch notifications: ${err.message}`)
          }

          if (notifications?.results?.length > 0) {
            debug(`Start._poll ${notifications.results.length} notifications polled hasMore: ${notifications.hasMore}, afterCursor: ${notifications.afterCursor}, beforeCursor: ${notifications.beforeCursor}`)
            for (const notification of _.sortBy(notifications.results, (n) => n.creationTime)) {
              if (notification?.payload &&
                  notification.payload.type === 'NEW_MESSAGE' &&
                  notification.conversationId === this.conversationId &&
                  notification.sender !== this.userId &&
                  !this.handledMessages.has(notification.id)) {
                const sprinklr = notification.payload.externalChatMessage
                let buttons = []

                if (sprinklr.messagePayload?.attachment?.buttons?.length) {
                  buttons = [...buttons, ...sprinklr.messagePayload.attachment.buttons.map(b => ({
                    text: b.title,
                    payload: b.url || b.title
                  }))]
                }

                if (sprinklr.messagePayload?.quickReplies?.buttons?.length) {
                  buttons = [...buttons, ...sprinklr.messagePayload.quickReplies.buttons.map(b => ({
                    text: b.title,
                    payload: b.payload
                  }))]
                }

                const msg = {
                  sender: 'bot',
                  messageText: sprinklr.messagePayload?.text || '',
                  buttons: buttons,
                  sourceData: notification
                }

                this.handledMessages.add(notification.id)
                debug(`Start._poll bot message: ${JSON.stringify(msg, null, 2)}`)
                await (this.messageSendingSemaphorePromise || Promise.resolve())
                setTimeout(() => this.queueBotSays(msg), 0)
              }
            }
          }
        } catch (err) {
          await (this.messageSendingSemaphorePromise || Promise.resolve())
          setTimeout(() => this.queueBotSays(`Start._poll notifications failed: ${err.message}`), 0)
        }

        if (this.pollingEnabled) {
          setTimeout(() => _poll(notifications?.afterCursor || cursor),
            this.caps[Capabilities.SPRINKL_RESPONSE_POLL_INTERVAL] || 100)
        } else {
          debug('Start._poll deactivated')
        }
      }

      this.pollingEnabled = true
      _poll()
    } catch (err) {
      throw new Error(`Failed to start conversation: ${err.message}`)
    }
  }

  // ============================================================================
  // USERSAYS - MODE-SPECIFIC MESSAGE SENDING
  // ============================================================================

  async UserSays (msg) {
    debug(`UserSays called ${util.inspect(msg)}`)

    if (this._isNlpTestingMode()) {
      // NLP Testing mode - Source-Agnostic API
      await this._ensureSAToken()

      const url = `https://api2.sprinklr.com/${this.saEnvironment}/api/v2/source-agnostic/${this.saAccountId}/send`

      const senderProfile = _.isString(this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE])
        ? JSON.parse(this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE])
        : this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE]

      const receiverProfile = _.isString(this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE])
        ? JSON.parse(this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE])
        : this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE]

      const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`

      const body = {
        messageId: messageId,
        conversationId: this.saConversationId,
        senderProfile: senderProfile,
        receiverProfile: receiverProfile,
        content: {
          text: msg.messageText
        }
      }

      debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      debug('📤 SENDING MESSAGE TO SPRINKLR (Source-Agnostic API)')
      debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      debug(`   URL: ${url}`)
      debug(`   Message ID: ${messageId}`)
      debug(`   Conversation ID: ${this.saConversationId}`)
      debug(`   Sender: ${senderProfile.id}`)
      debug(`   Receiver: ${receiverProfile.id}`)
      debug(`   Text: "${msg.messageText}"`)
      debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.saAuthToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        })

        if (!response.ok) {
          const errorText = await response.text()
          debug(`❌ Failed to send message: ${response.status}/${response.statusText} - ${errorText}`)
          throw new Error(`Failed to send message: ${response.status}/${response.statusText} - ${errorText}`)
        }

        const responseData = await response.json()
        debug('✅ Message sent successfully!')
        debug('   Response:', JSON.stringify(responseData, null, 2))

        if (responseData.data) {
          this.saCaseNumber = parseInt(responseData.data, 10)
          debug(`   📋 Case Number received: ${this.saCaseNumber}`)
          debug(`   ⏳ Waiting for webhook response with case number: ${this.saCaseNumber}`)
        } else {
          debug('   ⚠️  No case number in response')
        }

        if (responseData.errors && responseData.errors.length > 0) {
          debug('   ⚠️  Errors in response:', responseData.errors)
        }

        debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        debug('✅ UserSays NLP_TESTING: Message sent, awaiting webhook')
        debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      } catch (err) {
        debug(`❌ Error sending message: ${err.message}`)
        throw new Error(`Failed to send message in NLP_TESTING mode: ${err.message}`)
      }

      return
    }

    // ============================================================================
    // LIVE CHAT MODE - ORIGINAL API
    // ============================================================================

    try {
      const url = `https://${this.caps[Capabilities.SPRINKL_ENVIRONMENT]}-live-chat.sprinklr.com/api/livechat/v1/conversation/send`

      const body = {
        conversationId: this.conversationId,
        messagePayload: {
          text: msg.messageText,
          messageType: 'MESSAGE'
        }
      }

      if (msg.SPRINKLR_PARAM && _.isObject(msg.SPRINKLR_PARAM)) {
        body.additionalContext = Object.assign({}, msg.SPRINKLR_PARAM)
      }

      const options = {
        method: 'POST',
        headers: {
          'x-chat-token': this.chatSessionToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      }

      debug(`UserSays.messageSend requestOptions ${JSON.stringify({ url, options }, null, 2)}`)

      if (this.messageSendingSemaphorePromise) {
        debug('UserSays semaphore is not null!')
      }

      this.messageSendingSemaphorePromise = new Promise((resolve) => {
        this.messageSendingSemaphorePromiseResolve = resolve
      })

      const response = await fetch(url, options)

      if (this.messageSendingSemaphorePromiseResolve) {
        this.messageSendingSemaphorePromiseResolve()
        this.messageSendingSemaphorePromiseResolve = null
        this.messageSendingSemaphorePromise = null
      } else {
        debug('Stop semaphore resolve is not null!')
      }

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.status}/${response.statusText}`)
      }
    } catch (err) {
      throw new Error(`Failed to send message: ${err.message}`)
    }
  }

  // ============================================================================
  // STOP - MODE-SPECIFIC CLEANUP
  // ============================================================================

  Stop () {
    debug('Stop called')

    if (this._isNlpTestingMode()) {
      // NLP Testing mode cleanup
      this.processInbound = false
      this.saConversationId = null
      this.saCaseNumber = null
      this.saAuthToken = null
      this.saTokenExpiresAt = null
      this.saRefreshToken = null
      if (this.saPendingMessages) {
        this.saPendingMessages.clear()
      }
      if (this.redis) {
        this.redis.unsubscribe(this.redisTopic)
        debug('Redis unsubscribed from topic')
      }
    } else {
      // Live Chat mode cleanup (ORIGINAL)
      this.chatSessionToken = null
      this.userId = null
      this.conversationId = null
      this.pollingEnabled = false
      if (this.messageSendingSemaphorePromise) {
        debug('Stop semaphore is not null!')
      }
      this.messageSendingSemaphorePromise = null
      if (this.messageSendingSemaphorePromiseResolve) {
        debug('Stop semaphore resolve is not null!')
      }
      this.messageSendingSemaphorePromiseResolve = null
      this.handledMessages = null
    }
  }

  // ============================================================================
  // CLEAN - REDIS CLEANUP
  // ============================================================================

  async Clean () {
    debug('Clean called')
    if (this.redis) {
      try {
        await this.redis.quit()
        debug('Redis connection closed')
      } catch (err) {
        debug(`Error closing Redis connection: ${err.message}`)
      }
      this.redis = null
    }
  }
}

module.exports = BotiumConnectorSprinkl
