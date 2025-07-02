const util = require('util')
const debug = require('debug')('botium-connector-sprinkl')
const crypto = require('crypto')

const Capabilities = require('./Capabilities')
const _ = require('lodash')

class BotiumConnectorSprinkl {
  constructor ({ queueBotSays, caps }) {
    this.queueBotSays = queueBotSays
    this.caps = caps
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
  }

  async Validate () {
    debug('Validate called')
    if (this.caps[Capabilities.SPRINKL_CHAT_USER] && !this.caps[Capabilities.SPRINKL_API_KEY]) throw new Error('SPRINKL_API_KEY capability required in order to send chat user')
  }

  async Start () {
    debug('Start called')
    this.handledMessages = new Set()
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
        const u = _.isString(this.caps[Capabilities.SPRINKL_CHAT_USER]) ? JSON.parse(this.caps[Capabilities.SPRINKL_CHAT_USER]) : this.caps[Capabilities.SPRINKL_CHAT_USER]
        const hmac = crypto.createHmac('sha256', Buffer.from(this.caps[Capabilities.SPRINKL_API_KEY], 'utf8'))
        body.chatUser = 'userId_firstName_lastName_profileImageUrl_phoneNo_email'.split('_').map(e => u[e] || '').join('_')
        hmac.update(Buffer.from(body.chatUser, 'utf8'))
        body.chatUserSignature = hmac.digest('hex')
      }
      if (this.caps[Capabilities.SPRINKL_CUSTOM_CONTEXT]) {
        body.customContext = _.isString(this.caps[Capabilities.SPRINKL_CUSTOM_CONTEXT]) ? JSON.parse(this.caps[Capabilities.SPRINKL_CUSTOM_CONTEXT]) : this.caps[Capabilities.SPRINKL_CUSTOM_CONTEXT]
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

    try {
      const url = `https://${this.caps[Capabilities.SPRINKL_ENVIRONMENT].toLowerCase()}-live-chat.sprinklr.com/api/livechat/v1/conversation/new`

      const body = {
        appId: this.caps[Capabilities.SPRINKL_APP_ID]
      }
      if (this.caps[Capabilities.SPRINKL_STARTED_BY_CONTEXT]) {
        body.startedByContext = _.isString(this.caps[Capabilities.SPRINKL_STARTED_BY_CONTEXT]) ? JSON.parse(this.caps[Capabilities.SPRINKL_STARTED_BY_CONTEXT]) : this.caps[Capabilities.SPRINKL_STARTED_BY_CONTEXT]
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

      const _poll = async (cursor) => {
        const url = `https://${this.caps[Capabilities.SPRINKL_ENVIRONMENT]}-live-chat.sprinklr.com/api/livechat/v1/event/fetch-notifications?size=1000`

        const options = {
          method: 'GET',
          headers: {
            'x-chat-token': this.chatSessionToken,
            'content-type': 'application/json'
          }
        }
        const _humanReadable = (notifications) => {
          return JSON.stringify(notifications.results.filter(n => n?.payload && n.payload.type === 'NEW_MESSAGE' && n.conversationId === this.conversationId && n.sender !== this.userId).map(n => n.payload?.description))
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
          console.log(`notificationsSome ===> ${_humanReadable(notifications)}`)
          if (notifications?.results?.length > 0) {
            debug(`Start._poll ${notifications.results.length} notifications polled hasMore: ${notifications.hasMore}, afterCursor: ${notifications.afterCursor}, beforeCursor: ${notifications.beforeCursor}`)
            for (const notification of _.sortBy(notifications.results, (n) => n.creationTime)) {
              if (notification?.payload && notification.payload.type === 'NEW_MESSAGE' && notification.conversationId === this.conversationId && notification.sender !== this.userId && !this.handledMessages.has(notification.id)) {
                const sprinklr = notification.payload.externalChatMessage
                let buttons = []
                if (sprinklr.messagePayload?.attachment?.buttons?.length) {
                  buttons = [...buttons, ...sprinklr.messagePayload.attachment.buttons.map(b => ({
                    text: b.title,
                    payload: b.url || b.title
                  }))]
                }
                // if (sprinklr.messagePayload?.quickReplies?.quickReplies?.length) {
                //   buttons = [...buttons, ...sprinklr.messagePayload.quickReplies.quickReplies.map(b => ({
                //     text: b.title,
                //     payload: b.payload
                //   }))]
                // }
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

        // appId: this.caps[Capabilities.SPRINKL_APP_ID]
        if (this.pollingEnabled) {
          setTimeout(() => _poll(notifications?.afterCursor || cursor), this.caps[Capabilities.SPRINKL_RESPONSE_POLL_INTERVAL] || 100)
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

  async UserSays (msg) {
    debug(`UserSays called ${util.inspect(msg)}`)

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

  Stop () {
    debug('Stop called')
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

module.exports = BotiumConnectorSprinkl
