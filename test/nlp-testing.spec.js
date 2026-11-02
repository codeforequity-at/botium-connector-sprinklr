const assert = require('chai').assert
const BotiumConnectorSprinkl = require('../src/connector')
const Capabilities = require('../src/Capabilities')

describe('NLP Testing Mode', function () {
  describe('Mode Detection', function () {
    it('should default to LIVE_CHAT mode when not specified', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {}
      })
      assert.equal(connector._getMode(), 'LIVE_CHAT')
      assert.equal(connector._isNlpTestingMode(), false)
    })

    it('should detect NLP_TESTING mode when specified', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING'
        }
      })
      assert.equal(connector._getMode(), 'NLP_TESTING')
      assert.equal(connector._isNlpTestingMode(), true)
    })

    it('should detect LIVE_CHAT mode when explicitly specified', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'LIVE_CHAT'
        }
      })
      assert.equal(connector._getMode(), 'LIVE_CHAT')
      assert.equal(connector._isNlpTestingMode(), false)
    })
  })

  describe('Intent Extraction', function () {
    it('should extract intents from custom properties with field mapping', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]: {
            '_c_6a8d564990b44d451cc190c1': 'IntentField1',
            '_c_6a9829de6260eb23b3c24ccb': 'IntentField2'
          }
        }
      })

      const customProperties = {
        '_c_6a8d564990b44d451cc190c1': ['Greetings'],
        '_c_6a9829de6260eb23b3c24ccb': ['Help']
      }

      const nlp = connector._extractIntentFromWebhook(customProperties)

      assert.isNotNull(nlp)
      assert.isArray(nlp.intents)
      assert.equal(nlp.intents.length, 2)
      assert.equal(nlp.intents[0].name, 'Greetings')
      assert.equal(nlp.intents[0].confidence, 1.0)
      assert.equal(nlp.intents[1].name, 'Help')
      assert.equal(nlp.intent.name, 'Greetings')
    })

    it('should extract intents from triggered issue types', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING'
        }
      })

      const customProperties = {
        spr_triggered_issue_types: ['Intent Intent2 ( Cyara Test )'],
        spr_detected_issue_types: ['Another Intent']
      }

      const nlp = connector._extractIntentFromWebhook(customProperties)

      assert.isNotNull(nlp)
      assert.isArray(nlp.intents)
      assert.equal(nlp.intents.length, 2)
      assert.equal(nlp.intents[0].name, 'Intent Intent2 ( Cyara Test )')
      assert.equal(nlp.intents[1].name, 'Another Intent')
    })

    it('should handle multiple values in custom property arrays', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]: {
            '_c_test': 'TestField'
          }
        }
      })

      const customProperties = {
        '_c_test': ['Intent1', 'Intent2', 'Intent3']
      }

      const nlp = connector._extractIntentFromWebhook(customProperties)

      assert.isNotNull(nlp)
      assert.equal(nlp.intents.length, 3)
      assert.equal(nlp.intents[0].name, 'Intent1')
      assert.equal(nlp.intents[1].name, 'Intent2')
      assert.equal(nlp.intents[2].name, 'Intent3')
    })

    it('should return null when no intents are found', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING'
        }
      })

      const customProperties = {
        some_other_field: ['value']
      }

      const nlp = connector._extractIntentFromWebhook(customProperties)

      assert.isNull(nlp)
    })

    it('should deduplicate intents from different sources', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]: {
            '_c_test': 'TestField'
          }
        }
      })

      const customProperties = {
        '_c_test': ['Greetings'],
        spr_triggered_issue_types: ['Greetings', 'Help']
      }

      const nlp = connector._extractIntentFromWebhook(customProperties)

      assert.isNotNull(nlp)
      // Should have Greetings (from field mapping), then Greetings (duplicate skipped), then Help
      assert.equal(nlp.intents.length, 2)
      assert.equal(nlp.intents[0].name, 'Greetings')
      assert.equal(nlp.intents[1].name, 'Help')
    })

    it('should parse JSON string intent field mapping', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]: '{"_c_test": "TestField"}'
        }
      })

      const customProperties = {
        '_c_test': ['Intent1']
      }

      const nlp = connector._extractIntentFromWebhook(customProperties)

      assert.isNotNull(nlp)
      assert.equal(nlp.intents[0].name, 'Intent1')
    })
  })

  describe('Webhook Processing', function () {
    const createConnector = (queueBotSays, extraCaps = {}) => {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays,
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]: '_c_6a8d564990b44d451cc190c1',
          ...extraCaps
        }
      })
      connector.processInbound = true
      connector.saConversationId = 'case_test'
      connector.saCaseNumber = 183479
      connector.saAwaitingNlpResponse = true
      connector.saHandledWebhookIds = new Set()
      connector.saEmittedResponseCount = 0
      connector.saLastUserMessageText = 'hey'
      return connector
    }

    const caseUpdate = ({ id, version, description, intent, fanCount, latestMessageTime, convId }) => ({
      body: {
        id: id || `evt_${version || 1}`,
        type: 'case.update',
        payload: {
          caseNumber: 183479,
          version: version || 1,
          description: description || 'hey',
          associatedFanMessageCount: fanCount,
          latestMessageAssociatedTime: latestMessageTime,
          externalCase: {
            id: convId || 'case_test'
          },
          workflow: {
            customProperties: intent
              ? { '_c_6a8d564990b44d451cc190c1': [intent] }
              : {}
          }
        }
      }
    })

    it('should process case.update webhook with matching case number', function (done) {
      let queuedMessage = null
      const connector = createConnector((msg) => { queuedMessage = msg })
      connector.saLastUserMessageText = 'hello how are you'

      connector._processInboundEvent(caseUpdate({
        id: 'evt_1',
        description: 'hello how are you',
        intent: 'Greetings',
        fanCount: 1,
        latestMessageTime: 1000
      }))

      setTimeout(() => {
        assert.isNotNull(queuedMessage)
        assert.equal(queuedMessage.sender, 'bot')
        assert.equal(queuedMessage.messageText, 'hello how are you')
        assert.equal(queuedMessage.nlp.intent.name, 'Greetings')
        assert.isNotNull(queuedMessage.sourceData)
        assert.equal(connector.saAwaitingNlpResponse, false)
        done()
      }, 50)
    })

    it('should ignore webhook with non-matching case number', function (done) {
      let queuedMessage = null
      const connector = createConnector((msg) => { queuedMessage = msg })

      const event = caseUpdate({ id: 'evt_mismatch', intent: 'Greetings', fanCount: 1 })
      event.body.payload.caseNumber = 999999
      connector._processInboundEvent(event)

      setTimeout(() => {
        assert.isNull(queuedMessage)
        done()
      }, 50)
    })

    it('should ignore webhook when processInbound is false', function (done) {
      let queuedMessage = null
      const connector = createConnector((msg) => { queuedMessage = msg })
      connector.processInbound = false

      connector._processInboundEvent(caseUpdate({ id: 'evt_pi_false', intent: 'Greetings', fanCount: 1 }))

      setTimeout(() => {
        assert.isNull(queuedMessage)
        done()
      }, 50)
    })

    it('should ignore non-case.update event types', function (done) {
      let queuedMessage = null
      const connector = createConnector((msg) => { queuedMessage = msg })

      connector._processInboundEvent({
        body: {
          id: 'evt_create',
          type: 'case.create',
          payload: {
            caseNumber: 183479,
            externalCase: { id: 'case_test' }
          }
        }
      })

      setTimeout(() => {
        assert.isNull(queuedMessage)
        done()
      }, 50)
    })

    it('should extract intents from webhook custom properties', function (done) {
      let queuedMessage = null
      const connector = createConnector((msg) => { queuedMessage = msg }, {
        [Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]: {
          '_c_intent_field': 'IntentField'
        }
      })

      connector._processInboundEvent({
        body: {
          id: 'evt_intent',
          type: 'case.update',
          payload: {
            caseNumber: 183479,
            description: 'test message',
            associatedFanMessageCount: 1,
            externalCase: { id: 'case_test' },
            workflow: {
              customProperties: {
                '_c_intent_field': ['TestIntent'],
                'spr_triggered_issue_types': ['TriggeredIntent']
              }
            }
          }
        }
      })

      setTimeout(() => {
        assert.isNotNull(queuedMessage)
        assert.isNotNull(queuedMessage.nlp)
        assert.isNotNull(queuedMessage.nlp.intent)
        assert.equal(queuedMessage.nlp.intent.name, 'TestIntent')
        assert.equal(queuedMessage.nlp.intents.length, 2)
        done()
      }, 50)
    })

    it('should emit only one bot message for multiple case.update webhooks in one turn', function (done) {
      const queued = []
      const connector = createConnector((msg) => { queued.push(msg) })

      connector._processInboundEvent(caseUpdate({
        id: 'evt_a', version: 2, intent: 'Greetings', fanCount: 1, latestMessageTime: 1000
      }))
      connector._processInboundEvent(caseUpdate({
        id: 'evt_b', version: 3, intent: 'Greetings', fanCount: 1, latestMessageTime: 1000
      }))
      connector._processInboundEvent(caseUpdate({
        id: 'evt_c', version: 4, intent: 'Greetings', fanCount: 1, latestMessageTime: 1100
      }))

      setTimeout(() => {
        assert.equal(queued.length, 1)
        assert.equal(queued[0].nlp.intent.name, 'Greetings')
        assert.equal(connector.saAwaitingNlpResponse, false)
        done()
      }, 50)
    })

    it('should ignore duplicate webhook event ids', function (done) {
      const queued = []
      const connector = createConnector((msg) => { queued.push(msg) })

      const event = caseUpdate({
        id: 'evt_dup', intent: 'Greetings', fanCount: 1, latestMessageTime: 1000
      })
      // First one should emit and close the turn; duplicate id alone is also guarded
      connector._processInboundEvent(event)
      connector.saAwaitingNlpResponse = true
      connector._processInboundEvent(event)

      setTimeout(() => {
        assert.equal(queued.length, 1)
        done()
      }, 50)
    })

    it('should skip case.update without intent while awaiting', function (done) {
      let queuedMessage = null
      const connector = createConnector((msg) => { queuedMessage = msg })

      connector._processInboundEvent(caseUpdate({
        id: 'evt_no_intent', fanCount: 1, latestMessageTime: 1000, intent: null
      }))

      setTimeout(() => {
        assert.isNull(queuedMessage)
        assert.equal(connector.saAwaitingNlpResponse, true)
        done()
      }, 50)
    })

    it('should support multiple turns in one conversation with one response each', function (done) {
      const queued = []
      const connector = createConnector((msg) => { queued.push(msg) })

      // Turn 1: hi -> Greetings
      connector.saLastUserMessageText = 'hi'
      connector._processInboundEvent(caseUpdate({
        id: 'evt_t1_a', version: 2, description: 'hi', intent: 'Greetings',
        fanCount: 1, latestMessageTime: 1000
      }))
      connector._processInboundEvent(caseUpdate({
        id: 'evt_t1_b', version: 3, description: 'hi', intent: 'Greetings',
        fanCount: 1, latestMessageTime: 1000
      }))

      // Turn 2: how are you -> Help (same conversation / case)
      connector._armNlpTurn('how are you', 'msg_turn2')
      connector._processInboundEvent(caseUpdate({
        id: 'evt_t2_stale', version: 4, description: 'hi', intent: 'Greetings',
        fanCount: 1, latestMessageTime: 1000
      }))
      connector._processInboundEvent(caseUpdate({
        id: 'evt_t2_ok', version: 5, description: 'hi', intent: 'Help',
        fanCount: 2, latestMessageTime: 2000
      }))
      connector._processInboundEvent(caseUpdate({
        id: 'evt_t2_extra', version: 6, description: 'hi', intent: 'Help',
        fanCount: 2, latestMessageTime: 2000
      }))

      setTimeout(() => {
        assert.equal(queued.length, 2)
        assert.equal(queued[0].messageText, 'hi')
        assert.equal(queued[0].nlp.intent.name, 'Greetings')
        assert.equal(queued[1].messageText, 'how are you')
        assert.equal(queued[1].nlp.intent.name, 'Help')
        assert.equal(connector.saEmittedResponseCount, 2)
        assert.equal(connector.saAwaitingNlpResponse, false)
        done()
      }, 50)
    })

    it('should accept later turn when fan count advances even if intent is unchanged', function (done) {
      const queued = []
      const connector = createConnector((msg) => { queued.push(msg) })

      connector.saLastUserMessageText = 'hi'
      connector._processInboundEvent(caseUpdate({
        id: 'evt_u1', intent: 'Greetings', fanCount: 1, latestMessageTime: 1000
      }))

      connector._armNlpTurn('where are you', 'msg_turn2')
      connector._processInboundEvent(caseUpdate({
        id: 'evt_u2', intent: 'Greetings', fanCount: 2, latestMessageTime: 2000
      }))

      setTimeout(() => {
        assert.equal(queued.length, 2)
        assert.equal(queued[1].messageText, 'where are you')
        assert.equal(queued[1].nlp.intent.name, 'Greetings')
        done()
      }, 50)
    })
  })

  describe('Validation', function () {
    it('should require SPRINKL_SA_ACCOUNT_ID in NLP_TESTING mode', async function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_AUTH_TOKEN]: 'token123'
        }
      })

      try {
        await connector.Validate()
        assert.fail('Should have thrown error')
      } catch (err) {
        assert.include(err.message, 'SPRINKL_SA_ACCOUNT_ID')
      }
    })

    it('should require OAuth client credentials in NLP_TESTING mode', async function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_ACCOUNT_ID]: '300289798'
        }
      })

      try {
        await connector.Validate()
        assert.fail('Should have thrown error')
      } catch (err) {
        assert.include(err.message, 'SPRINKL_SA_CLIENT_ID')
      }
    })

    it('should require SPRINKL_SA_CLIENT_SECRET when client id is present', async function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_ACCOUNT_ID]: '300289798',
          [Capabilities.SPRINKL_SA_CLIENT_ID]: 'client-id'
        }
      })

      try {
        await connector.Validate()
        assert.fail('Should have thrown error')
      } catch (err) {
        assert.include(err.message, 'SPRINKL_SA_CLIENT_SECRET')
      }
    })

    it('should require LIVE_CHAT capabilities in LIVE_CHAT mode', async function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'LIVE_CHAT'
        }
      })

      try {
        await connector.Validate()
        assert.fail('Should have thrown error')
      } catch (err) {
        assert.include(err.message, 'SPRINKL_ENVIRONMENT')
      }
    })
  })
})
