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
    this.saAwaitingNlpResponse = false // One bot response per UserSays turn
    this.saHandledWebhookIds = new Set() // Deduplicate Sprinklr webhook event ids
    this.saLastUserMessageText = null
    this.saLastMessageId = null
    this.saEmittedResponseCount = 0
    this.saLastEmittedIntentName = null
    this.saLastSeenFanCount = null
    this.saLastSeenLatestMessageTime = null
    this.saTurnBaselineFanCount = null
    this.saTurnBaselineLatestMessageTime = null
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
    const environment = this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT] || 'prod3'
    const tokenUrl = `https://api3.sprinklr.com/${environment}/oauth/token`
    const maskedClientId = this.caps[Capabilities.SPRINKL_SA_CLIENT_ID]?.substring(0, 8) + '...'

    debug(`Fetching OAuth token (client_credentials) for ${maskedClientId}`)

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.caps[Capabilities.SPRINKL_SA_CLIENT_ID],
      client_secret: this.caps[Capabilities.SPRINKL_SA_CLIENT_SECRET]
    })

    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`SA OAuth token fetch failed: ${response.status}/${response.statusText} - ${errorText}`)
      }

      const data = await response.json()
      this._storeSAToken(data)
      debug('OAuth token acquired')
    } catch (err) {
      debug(`OAuth token fetch error: ${err.message}`)
      throw err
    }
  }

  async _refreshSAToken () {
    const environment = this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT] || 'prod3'
    const tokenUrl = `https://api3.sprinklr.com/${environment}/oauth/token`

    debug('Refreshing OAuth token')

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.caps[Capabilities.SPRINKL_SA_CLIENT_ID],
      client_secret: this.caps[Capabilities.SPRINKL_SA_CLIENT_SECRET],
      refresh_token: this.saRefreshToken
    })

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })

    if (!response.ok) {
      debug(`OAuth refresh failed (${response.status}), falling back to client_credentials`)
      await this._fetchSAToken()
      return
    }

    const data = await response.json()
    this._storeSAToken(data)
    debug('OAuth token refreshed')
  }

  _storeSAToken (data) {
    this.saAuthToken = data.access_token
    this.saRefreshToken = data.refresh_token || this.saRefreshToken
    // Expire 60 seconds early to avoid edge-case expiry mid-request
    this.saTokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000
    const secondsUntilExpiry = Math.floor((this.saTokenExpiresAt - Date.now()) / 1000)
    debug(`OAuth token stored, valid for ${secondsUntilExpiry}s`)
  }

  async _ensureSAToken () {
    const now = Date.now()
    const hasToken = !!this.saAuthToken
    const isExpired = hasToken && now >= this.saTokenExpiresAt
    const secondsRemaining = hasToken && !isExpired ? Math.floor((this.saTokenExpiresAt - now) / 1000) : 0

    if (!this.saAuthToken || Date.now() >= this.saTokenExpiresAt) {
      if (this.saRefreshToken && this.saAuthToken) {
        await this._refreshSAToken()
      } else {
        await this._fetchSAToken()
      }
    } else {
      debug(`OAuth token valid (${secondsRemaining}s remaining)`)
    }
  }

  // NLP TESTING MODE - WEBHOOK PROCESSING
  // ============================================================================

  _resolveIntentFieldMapping () {
    let mapping = this.caps[Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]
    if (!mapping) return null

    if (_.isString(mapping)) {
      try {
        const parsed = JSON.parse(mapping)
        mapping = parsed
      } catch (err) {
        // Plain field id string, e.g. "_c_6a8d564990b44d451cc190c1"
        return mapping
      }
    }

    return mapping
  }

  _addUniqueIntent (nlp, intentName, confidence) {
    if (!intentName || nlp.intents.some(i => i.name === intentName)) return
    nlp.intents.push({ name: intentName, confidence })
  }

  _extractIntentFromWebhook (customProperties) {
    const nlp = { intents: [] }
    const mapping = this._resolveIntentFieldMapping()

    if (_.isString(mapping) && mapping) {
      const intentArray = customProperties[mapping]
      if (intentArray && Array.isArray(intentArray) && intentArray.length > 0) {
        intentArray.forEach(intentName => this._addUniqueIntent(nlp, intentName, 1.0))
      }
    } else if (mapping && _.isObject(mapping)) {
      Object.keys(mapping).forEach(fieldId => {
        const intentArray = customProperties[fieldId]
        if (intentArray && Array.isArray(intentArray) && intentArray.length > 0) {
          intentArray.forEach(intentName => this._addUniqueIntent(nlp, intentName, 1.0))
        }
      })
    }

    const triggeredIssues = customProperties.spr_triggered_issue_types || []
    triggeredIssues.forEach(issue => this._addUniqueIntent(nlp, issue, 1.0))

    const detectedIssues = customProperties.spr_detected_issue_types || []
    detectedIssues.forEach(issue => this._addUniqueIntent(nlp, issue, 0.9))

    if (nlp.intents.length > 0) {
      nlp.intents.sort((a, b) => b.confidence - a.confidence)
      nlp.intent = nlp.intents[0]
    }

    return nlp.intents.length > 0 ? nlp : null
  }

  _resetNlpTurnState () {
    this.saAwaitingNlpResponse = false
    this.saHandledWebhookIds = new Set()
    this.saLastUserMessageText = null
    this.saLastMessageId = null
    this.saEmittedResponseCount = 0
    this.saLastEmittedIntentName = null
    this.saLastSeenFanCount = null
    this.saLastSeenLatestMessageTime = null
    this.saTurnBaselineFanCount = null
    this.saTurnBaselineLatestMessageTime = null
  }

  _armNlpTurn (messageText, messageId) {
    this.saAwaitingNlpResponse = true
    this.saLastUserMessageText = messageText || ''
    this.saLastMessageId = messageId || null
    this.saTurnBaselineFanCount = this.saLastSeenFanCount
    this.saTurnBaselineLatestMessageTime = this.saLastSeenLatestMessageTime
  }

  _isEligibleNlpTurnUpdate (payload, nlp) {
    if (this.saEmittedResponseCount === 0) {
      return true
    }

    const fanCount = payload.associatedFanMessageCount
    const latestMessageTime = payload.latestMessageAssociatedTime
    const intentName = nlp?.intent?.name || null

    const fanIncreased = this.saTurnBaselineFanCount != null &&
      fanCount != null &&
      fanCount > this.saTurnBaselineFanCount
    const timeAdvanced = this.saTurnBaselineLatestMessageTime != null &&
      latestMessageTime != null &&
      latestMessageTime > this.saTurnBaselineLatestMessageTime
    const intentChanged = intentName &&
      this.saLastEmittedIntentName &&
      intentName !== this.saLastEmittedIntentName

    return !!(fanIncreased || timeAdvanced || intentChanged)
  }

  _processInboundEvent (event) {
    if (!this.processInbound || !this.saAwaitingNlpResponse) {
      return
    }

    const body = event.body
    if (!body || body.type !== 'case.update' || !body.payload) {
      return
    }

    if (body.id) {
      if (this.saHandledWebhookIds.has(body.id)) {
        return
      }
      this.saHandledWebhookIds.add(body.id)
    }

    const payload = body.payload
    const inboundCaseNumber = payload.caseNumber
    if (!inboundCaseNumber || inboundCaseNumber !== this.saCaseNumber) {
      return
    }

    const caseText = payload.description || payload.subject || ''
    const messageText = this.saLastUserMessageText || caseText
    const customProps = payload.workflow?.customProperties || {}
    if (Object.keys(customProps).length === 0) {
      return
    }

    const nlp = this._extractIntentFromWebhook(customProps)
    if (!nlp || !this._isEligibleNlpTurnUpdate(payload, nlp)) {
      return
    }

    const botMsg = {
      sender: 'bot',
      messageText: messageText,
      sourceData: body,
      nlp
    }

    this.saAwaitingNlpResponse = false
    this.saEmittedResponseCount += 1
    this.saLastEmittedIntentName = nlp.intent?.name || null
    if (payload.associatedFanMessageCount != null) {
      this.saLastSeenFanCount = payload.associatedFanMessageCount
    }
    if (payload.latestMessageAssociatedTime != null) {
      this.saLastSeenLatestMessageTime = payload.latestMessageAssociatedTime
    }

    debug(`NLP response: intent=${nlp.intent?.name}, text="${messageText}"`)
    setTimeout(() => this.queueBotSays(botMsg), 0)
  }

  // BUILD - REDIS SETUP FOR NLP TESTING MODE
  // ============================================================================

  async Build () {
    debug('Build called')
    this.mode = this._getMode()

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
        debug('Redis connection verified')
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
      const missingCaps = []
      const providedCaps = []

      if (!this.caps[Capabilities.SPRINKL_SA_ACCOUNT_ID]) {
        missingCaps.push('SPRINKL_SA_ACCOUNT_ID')
        throw new Error('SPRINKL_SA_ACCOUNT_ID capability required for NLP_TESTING mode')
      }
      providedCaps.push('SPRINKL_SA_ACCOUNT_ID')

      if (!this.caps[Capabilities.SPRINKL_SA_CLIENT_ID]) {
        missingCaps.push('SPRINKL_SA_CLIENT_ID')
        throw new Error('SPRINKL_SA_CLIENT_ID capability required for NLP Testing mode (OAuth 2.0)')
      }
      providedCaps.push('SPRINKL_SA_CLIENT_ID')

      if (!this.caps[Capabilities.SPRINKL_SA_CLIENT_SECRET]) {
        missingCaps.push('SPRINKL_SA_CLIENT_SECRET')
        throw new Error('SPRINKL_SA_CLIENT_SECRET capability required for NLP Testing mode (OAuth 2.0)')
      }
      providedCaps.push('SPRINKL_SA_CLIENT_SECRET')

      if (!this.caps[Capabilities.SPRINKL_SA_ENVIRONMENT]) {
        missingCaps.push('SPRINKL_SA_ENVIRONMENT')
        throw new Error('SPRINKL_SA_ENVIRONMENT capability required for NLP Testing mode')
      }
      providedCaps.push('SPRINKL_SA_ENVIRONMENT')

      if (!this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE]) {
        missingCaps.push('SPRINKL_SA_SENDER_PROFILE')
        throw new Error('SPRINKL_SA_SENDER_PROFILE capability required for NLP Testing mode')
      }
      providedCaps.push('SPRINKL_SA_SENDER_PROFILE')
      const senderProfile = _.isString(this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE])
        ? JSON.parse(this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE])
        : this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE]
      if (!senderProfile || !senderProfile.id) {
        throw new Error('SPRINKL_SA_SENDER_PROFILE must have an "id" field')
      }

      if (!this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE]) {
        missingCaps.push('SPRINKL_SA_RECEIVER_PROFILE')
        throw new Error('SPRINKL_SA_RECEIVER_PROFILE capability required for NLP Testing mode')
      }
      providedCaps.push('SPRINKL_SA_RECEIVER_PROFILE')
      const receiverProfile = _.isString(this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE])
        ? JSON.parse(this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE])
        : this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE]
      if (!receiverProfile || !receiverProfile.id) {
        throw new Error('SPRINKL_SA_RECEIVER_PROFILE must have an "id" field')
      }

      try {
        await this._fetchSAToken()
      } catch (err) {
        throw new Error(`SA OAuth credential validation failed: ${err.message}`)
      }

      debug(`NLP Testing validation passed (${providedCaps.length}/6 capabilities)`)
    } else {
      // Live Chat mode validation (ORIGINAL API)

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

      // Auto-generate conversation ID (reused across turns in this session)
      this.saConversationId = `case_${crypto.randomBytes(16).toString('hex')}`
      this.saCaseNumber = null // Will be set after first message
      this.saPendingMessages.clear()
      this._resetNlpTurnState()

      if (this.redis) {
        await this.redis.subscribe(this.redisTopic)
        this.processInbound = true
      } else {
        debug('Warning: Redis not initialized in NLP_TESTING mode')
      }

      debug(`NLP Testing started: accountId=${this.saAccountId}, conversationId=${this.saConversationId}, environment=${this.saEnvironment}`)

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
      await this._ensureSAToken()

      const url = `https://api2.sprinklr.com/${this.saEnvironment}/api/v2/source-agnostic/${this.saAccountId}/send`

      const senderProfile = _.isString(this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE])
        ? JSON.parse(this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE])
        : this.caps[Capabilities.SPRINKL_SA_SENDER_PROFILE]

      const receiverProfile = _.isString(this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE])
        ? JSON.parse(this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE])
        : this.caps[Capabilities.SPRINKL_SA_RECEIVER_PROFILE]

      // New messageId per turn, same conversationId for the session
      const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`
      this._armNlpTurn(msg.messageText, messageId)

      const body = {
        messageId: messageId,
        conversationId: this.saConversationId,
        senderProfile: senderProfile,
        receiverProfile: receiverProfile,
        content: {
          text: msg.messageText
        }
      }

      debug(`Sending SA message: conversationId=${this.saConversationId}, messageId=${messageId}, text="${msg.messageText}"`)

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
          throw new Error(`Failed to send message: ${response.status}/${response.statusText} - ${errorText}`)
        }

        const responseData = await response.json()
        if (responseData.data) {
          this.saCaseNumber = parseInt(responseData.data, 10)
          debug(`SA message sent, caseNumber=${this.saCaseNumber}`)
        } else {
          debug('SA message sent, but no case number in response')
        }

        if (responseData.errors && responseData.errors.length > 0) {
          debug(`SA send response errors: ${JSON.stringify(responseData.errors)}`)
        }
      } catch (err) {
        debug(`SA send error: ${err.message}`)
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
      this._resetNlpTurnState()
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
