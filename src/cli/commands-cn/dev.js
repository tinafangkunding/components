/*
 * CLI: Command: Dev
 */

const chokidar = require('chokidar')
const { ServerlessSDK, utils: tencentUtils } = require('@serverless/tencent-platform-client')
const utils = require('./utils')

let instanceStatusPollingTimeoutId = null
let instanceStatusPollingId = null
let isInstanceStatusPollingCanceled = false
let instanceCache = null

function cancelInstanceStatusPolling() {
  if (instanceStatusPollingId) {
    clearTimeout(instanceStatusPollingId)
    instanceStatusPollingId = null
  }
  isInstanceStatusPollingCanceled = true
}

function pollingInstanceStatus(sdk, instance, eventCallback) {
  if (eventCallback === false) {
    cancelInstanceStatusPolling()
    if (!instanceStatusPollingTimeoutId) {
      clearTimeout(instanceStatusPollingTimeoutId)
      instanceStatusPollingTimeoutId = null
    }
    return
  }

  isInstanceStatusPollingCanceled = false

  const pollingTimeout = 24000
  const statusPollingTime = 500
  const statusPollingFunc = async () => {
    const { instance: instanceStatusObj } = await sdk.getInstance(
      instance.org,
      instance.stage,
      instance.app,
      instance.name
    )

    instanceStatusPollingId = null
    if (isInstanceStatusPollingCanceled) {
      return
    }

    const {
      instanceStatus,
      instanceName,
      deploymentError,
      deploymentErrorStack
    } = instanceStatusObj
    switch (instanceStatus) {
      case 'deploying':
        instanceStatusPollingId = setTimeout(statusPollingFunc, statusPollingTime)
        break
      case 'active':
        await eventCallback({
          event: 'instance.deployment.succeeded',
          instanceName,
          data: instanceStatusObj
        })
        break
      case 'error':
        await eventCallback({
          event: 'instance.deployment.failed',
          instanceName,
          data: { message: deploymentError, stack: deploymentErrorStack }
        })
        break
      default:
        console.log('unknown status:', instanceStatus)
    }
  }

  if (!instanceStatusPollingId) {
    instanceStatusPollingId = setTimeout(statusPollingFunc, statusPollingTime)
  }

  if (!instanceStatusPollingTimeoutId) {
    clearTimeout(instanceStatusPollingTimeoutId)
    instanceStatusPollingTimeoutId = null
  }
  instanceStatusPollingTimeoutId = setTimeout(cancelInstanceStatusPolling, pollingTimeout)
}

async function stopTencentRemoteDebug() {
  if (instanceCache && instanceCache.state) {
    const { lambdaArn, region } = instanceCache.state
    if (lambdaArn && region) {
      await tencentUtils.stopTencentRemoteLogAndDebug(lambdaArn, region)
    }
  }
}

/*
 * Deploy changes and hookup event callback which will be called when
 * deploying status has been changed.
 * @param sdk - instance of ServerlessSDK
 * @param instance - instance object
 * @param credentials - credentials used for deploy
 * @param enventCallback - event callback, when set to false, it will remove all event listener
 */
async function deploy(sdk, instance, credentials, eventCallback) {
  // note: we do not pass { dev: true } as options here since we'll handle dev mode using tencent sdk
  try {
    await stopTencentRemoteDebug()
    await sdk.deploy(instance, credentials)
  } catch (e) {
    if (!eventCallback) {
      console.error(e)
    }
  }
  pollingInstanceStatus(sdk, instance, eventCallback)
}

module.exports = async (config, cli) => {
  // Define a close handler, that removes any "dev" mode agents
  const closeHandler = async () => {
    // Set new close listener
    process.on('SIGINT', () => {
      cli.close('error', 'Dev Mode Canceled.  Run "serverless deploy" To Remove Dev Mode Agent.')
    })

    cli.status('Disabling Dev Mode & Closing', null, 'green')
    await deploy(sdk, instanceYaml, instanceCredentials, false)

    cli.close('success', 'Dev Mode Closed')
  }

  // Start CLI persistance status
  cli.start('Initializing', { closeHandler })

  // Get access key
  const accessKey = await utils.getAccessKey()

  // Presentation
  cli.logLogo()
  cli.log(
    'Dev Mode - Watching your Component for changes and enabling streaming logs, if supported...',
    'grey'
  )
  cli.log()

  // Load serverless component instance.  Submit a directory where its config files should be.
  let instanceYaml = await utils.loadInstanceConfig(process.cwd())

  // Load Instance Credentials
  const instanceCredentials = await utils.loadInstanceCredentials(instanceYaml.stage)

  const sdk = new ServerlessSDK({
    accessKey,
    context: {
      orgName: instanceYaml.org
    }
  })

  cli.status('Initializing', instanceYaml.name)

  /**
   * Event Handler tells this client what to do with Serverless Platform Events received via websockets
   */

  const onEvent = async (event) => {
    const d = new Date()

    // Deployment
    if (event.event === 'instance.deployment.succeeded') {
      const header = `${d.toLocaleTimeString()} - ${event.instanceName} - deployment`
      instanceCache = event.data
      const { state } = instanceCache
      const { lambdaArn, region } = state
      if (lambdaArn && region) {
        await tencentUtils.startTencentRemoteLogAndDebug(lambdaArn, region)
      }
      cli.log(header, 'grey')
      cli.logOutputs(event.data.outputs)
      cli.status('Watching')
    }
    if (event.event === 'instance.deployment.failed') {
      const header = `${d.toLocaleTimeString()} - ${event.instanceName} - deployment error`
      cli.log(header, 'grey')
      cli.log(event.data.stack, 'red')
      cli.status('Watching')
    }
  }

  // Filter configuration
  const filter = {
    stageName: instanceYaml.stage,
    appName: instanceYaml.app,
    instanceName: instanceYaml.name,
    events: []
  }

  // User wants to receive all messages at the app level
  if (config.filter && config.filter === 'app' && filter.instanceName) {
    delete filter.instanceName
    cli.log('Enabling filtering at the activity at the application level', 'grey')
    cli.log()
  }

  /**
   * Watch logic
   */

  let isProcessing = false // whether there's already a deployment in progress
  let queuedOperation = false // whether there's another deployment queued

  // Set watcher
  const watcher = chokidar.watch(process.cwd(), { ignored: /\.serverless/ })

  watcher.on('ready', async () => {
    cli.status('Enabling Dev Mode', null, 'green')
    await deploy(sdk, instanceYaml, instanceCredentials, onEvent)
  })

  watcher.on('change', async () => {
    // Skip if processing already and there is a queued operation
    if (isProcessing && queuedOperation) {
      return
    }

    // If already deploying and user made more changes, queue another deploy operation to be run after the first one
    if (isProcessing && !queuedOperation) {
      queuedOperation = true
      return
    }

    // If it's not processin and there is no queued operation
    if (!isProcessing) {
      isProcessing = true
      cli.status('Deploying', null, 'green')
      // reload serverless component instance
      instanceYaml = await utils.loadInstanceConfig(process.cwd())
      await deploy(sdk, instanceYaml, instanceCredentials, onEvent)
      if (queuedOperation) {
        cli.status('Deploying', null, 'green')
        // reload serverless component instance
        instanceYaml = await utils.loadInstanceConfig(process.cwd())
        await deploy(sdk, instanceYaml, instanceCredentials, onEvent)
      }

      isProcessing = false
      queuedOperation = false
    }
  })
}
