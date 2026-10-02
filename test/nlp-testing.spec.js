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
    it('should process case.update webhook with matching conversation ID', function (done) {
      let queuedMessage = null
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: (msg) => {
          queuedMessage = msg
        },
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING'
        }
      })

      connector.processInbound = true
      connector.saConversationId = 'case_1a24d122ade41d35331ssa3'

      const webhookEvent = {
        body: {
          type: 'case.update',
          payload: {
            description: 'hello how are you',
            externalCase: {
              id: 'case_1a24d122ade41d35331ssa3'
            },
            workflow: {
              customProperties: {
                '_c_6a8d564990b44d451cc190c1': ['Greetings']
              }
            }
          }
        }
      }

      connector._processInboundEvent(webhookEvent)

      // Wait for async queueBotSays
      setTimeout(() => {
        assert.isNotNull(queuedMessage)
        assert.equal(queuedMessage.sender, 'bot')
        assert.equal(queuedMessage.messageText, 'hello how are you')
        assert.isNotNull(queuedMessage.sourceData)
        done()
      }, 50)
    })

    it('should ignore webhook with non-matching conversation ID', function (done) {
      let queuedMessage = null
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: (msg) => {
          queuedMessage = msg
        },
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING'
        }
      })

      connector.processInbound = true
      connector.saConversationId = 'case_expected_id'

      const webhookEvent = {
        body: {
          type: 'case.update',
          payload: {
            description: 'test message',
            externalCase: {
              id: 'case_different_id'
            }
          }
        }
      }

      connector._processInboundEvent(webhookEvent)

      setTimeout(() => {
        assert.isNull(queuedMessage)
        done()
      }, 50)
    })

    it('should ignore webhook when processInbound is false', function (done) {
      let queuedMessage = null
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: (msg) => {
          queuedMessage = msg
        },
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING'
        }
      })

      connector.processInbound = false
      connector.saConversationId = 'case_test'

      const webhookEvent = {
        body: {
          type: 'case.update',
          payload: {
            description: 'test',
            externalCase: { id: 'case_test' }
          }
        }
      }

      connector._processInboundEvent(webhookEvent)

      setTimeout(() => {
        assert.isNull(queuedMessage)
        done()
      }, 50)
    })

    it('should ignore non-case.update event types', function (done) {
      let queuedMessage = null
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: (msg) => {
          queuedMessage = msg
        },
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING'
        }
      })

      connector.processInbound = true
      connector.saConversationId = 'case_test'

      const webhookEvent = {
        body: {
          type: 'case.create',
          payload: {
            externalCase: { id: 'case_test' }
          }
        }
      }

      connector._processInboundEvent(webhookEvent)

      setTimeout(() => {
        assert.isNull(queuedMessage)
        done()
      }, 50)
    })

    it('should extract intents from webhook custom properties', function (done) {
      let queuedMessage = null
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: (msg) => {
          queuedMessage = msg
        },
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_INTENT_FIELD_MAPPING]: {
            '_c_intent_field': 'IntentField'
          }
        }
      })

      connector.processInbound = true
      connector.saConversationId = 'case_test'

      const webhookEvent = {
        body: {
          type: 'case.update',
          payload: {
            description: 'test message',
            externalCase: { id: 'case_test' },
            workflow: {
              customProperties: {
                '_c_intent_field': ['TestIntent'],
                'spr_triggered_issue_types': ['TriggeredIntent']
              }
            }
          }
        }
      }

      connector._processInboundEvent(webhookEvent)

      setTimeout(() => {
        assert.isNotNull(queuedMessage)
        assert.isNotNull(queuedMessage.nlp)
        assert.isNotNull(queuedMessage.nlp.intent)
        assert.equal(queuedMessage.nlp.intent.name, 'TestIntent')
        assert.equal(queuedMessage.nlp.intents.length, 2)
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

    it('should require SPRINKL_SA_AUTH_TOKEN in NLP_TESTING token mode', async function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_ACCOUNT_ID]: '300289798',
          [Capabilities.SPRINKL_SA_AUTH_MODE]: 'token'
        }
      })

      try {
        await connector.Validate()
        assert.fail('Should have thrown error')
      } catch (err) {
        assert.include(err.message, 'SPRINKL_SA_AUTH_TOKEN')
      }
    })

    it('should require OAuth credentials in client-credentials mode', async function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_ACCOUNT_ID]: '300289798',
          [Capabilities.SPRINKL_SA_AUTH_MODE]: 'client-credentials'
        }
      })

      try {
        await connector.Validate()
        assert.fail('Should have thrown error')
      } catch (err) {
        assert.include(err.message, 'SPRINKL_SA_CLIENT_ID')
      }
    })

    it('should detect OAuth vs token authentication mode', function () {
      const connectorToken = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_AUTH_MODE]: 'token'
        }
      })
      assert.equal(connectorToken._getSAAuthMode(), 'token')
      assert.equal(connectorToken._isSAOAuthMode(), false)

      const connectorOAuth = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING',
          [Capabilities.SPRINKL_SA_AUTH_MODE]: 'client-credentials'
        }
      })
      assert.equal(connectorOAuth._getSAAuthMode(), 'client-credentials')
      assert.equal(connectorOAuth._isSAOAuthMode(), true)
    })

    it('should default to token mode if not specified', function () {
      const connector = new BotiumConnectorSprinkl({
        queueBotSays: () => {},
        caps: {
          [Capabilities.SPRINKL_MODE]: 'NLP_TESTING'
        }
      })
      assert.equal(connector._getSAAuthMode(), 'token')
      assert.equal(connector._isSAOAuthMode(), false)
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
