import * as Sentry from '@sentry/node'
import { Server } from 'http'
import { CompressionCodecs, CompressionTypes, Consumer, KafkaJSProtocolError } from 'kafkajs'
// @ts-expect-error no type definitions
import SnappyCodec from 'kafkajs-snappy'
import * as schedule from 'node-schedule'
import { Counter } from 'prom-client'

import { getPluginServerCapabilities } from '../capabilities'
import { defaultConfig, sessionRecordingBlobConsumerConfig } from '../config/config'
import { Hub, PluginServerCapabilities, PluginsServerConfig } from '../types'
import { createHub } from '../utils/db/hub'
import { captureEventLoopMetrics } from '../utils/metrics'
import { cancelAllScheduledJobs } from '../utils/node-schedule'
import { PubSub } from '../utils/pubsub'
import { status } from '../utils/status'
import { createPostgresPool, createRedisPool, delay } from '../utils/utils'
import { TeamManager } from '../worker/ingestion/team-manager'
import Piscina, { makePiscina as defaultMakePiscina } from '../worker/piscina'
import { GraphileWorker } from './graphile-worker/graphile-worker'
import { loadPluginSchedule } from './graphile-worker/schedule'
import { startGraphileWorker } from './graphile-worker/worker-setup'
import { startAnalyticsEventsIngestionConsumer } from './ingestion-queues/analytics-events-ingestion-consumer'
import { startAnalyticsEventsIngestionOverflowConsumer } from './ingestion-queues/analytics-events-ingestion-overflow-consumer'
import { startJobsConsumer } from './ingestion-queues/jobs-consumer'
import { IngestionConsumer, KafkaJSIngestionConsumer } from './ingestion-queues/kafka-queue'
import {
    startAsyncHandlerConsumer,
    startAsyncOnEventHandlerConsumer,
    startAsyncWebhooksHandlerConsumer,
} from './ingestion-queues/on-event-handler-consumer'
import { startScheduledTasksConsumer } from './ingestion-queues/scheduled-tasks-consumer'
import { SessionRecordingBlobIngester } from './ingestion-queues/session-recording/session-recordings-blob-consumer'
import { startSessionRecordingEventsConsumer } from './ingestion-queues/session-recording/session-recordings-consumer'
import { createHttpServer } from './services/http-server'
import { getObjectStorage } from './services/object_storage'

CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec

const { version } = require('../../package.json')

// TODO: refactor this into a class, removing the need for many different Servers
export type ServerInstance = {
    hub: Hub
    piscina: Piscina
    queue: KafkaJSIngestionConsumer | IngestionConsumer | null
    stop: () => Promise<void>
}

export async function startPluginsServer(
    config: Partial<PluginsServerConfig>,
    makePiscina: (serverConfig: PluginsServerConfig, hub: Hub) => Promise<Piscina> = defaultMakePiscina,
    capabilities: PluginServerCapabilities | undefined
): Promise<Partial<ServerInstance>> {
    const timer = new Date()

    const serverConfig: PluginsServerConfig = {
        ...defaultConfig,
        ...config,
    }

    status.updatePrompt(serverConfig.PLUGIN_SERVER_MODE)
    status.info('ℹ️', `${serverConfig.WORKER_CONCURRENCY} workers, ${serverConfig.TASKS_PER_WORKER} tasks per worker`)

    // Structure containing initialized clients for Postgres, Kafka, Redis, etc.
    let hub: Hub | undefined

    // Used to trigger reloads of plugin code/config
    let pubSub: PubSub | undefined

    // A Node Worker Thread pool
    let piscina: Piscina | undefined

    // Ingestion Kafka consumer. Handles both analytics events and screen
    // recording events. The functionality roughly looks like:
    //
    // 1. events come in via the /e/ and friends endpoints and published to the
    //    plugin_events_ingestion Kafka topic.
    // 2. this queue consumes from the plugin_events_ingestion topic.
    // 3. update or creates people in the Persons table in pg with the new event
    //    data.
    // 4. passes the event through `processEvent` on any plugins that the team
    //    has enabled.
    // 5. publishes the resulting event to a Kafka topic on which ClickHouse is
    //    listening.
    let analyticsEventsIngestionConsumer: KafkaJSIngestionConsumer | IngestionConsumer | undefined
    let analyticsEventsIngestionOverflowConsumer: KafkaJSIngestionConsumer | IngestionConsumer | undefined
    let onEventHandlerConsumer: KafkaJSIngestionConsumer | undefined
    let webhooksHandlerConsumer: KafkaJSIngestionConsumer | undefined

    // Kafka consumer. Handles events that we couldn't find an existing person
    // to associate. The buffer handles delaying the ingestion of these events
    // (default 60 seconds) to allow for the person to be created in the
    // meantime.
    let bufferConsumer: Consumer | undefined
    let stopSessionRecordingEventsConsumer: (() => void) | undefined
    let stopSessionRecordingBlobConsumer: (() => void) | undefined
    let joinSessionRecordingEventsConsumer: ((timeout?: number) => Promise<void>) | undefined
    let joinSessionRecordingBlobConsumer: ((timeout?: number) => Promise<void>) | undefined
    let jobsConsumer: Consumer | undefined
    let schedulerTasksConsumer: Consumer | undefined

    let httpServer: Server | undefined // healthcheck server

    let graphileWorker: GraphileWorker | undefined

    let closeHub: (() => Promise<void>) | undefined

    let lastActivityCheck: NodeJS.Timeout | undefined
    let stopEventLoopMetrics: (() => void) | undefined

    let shuttingDown = false
    async function closeJobs(): Promise<void> {
        shuttingDown = true
        status.info('💤', ' Shutting down gracefully...')
        lastActivityCheck && clearInterval(lastActivityCheck)

        // HACKY: Stop all consumers and the graphile worker, as well as the
        // http server. Note that we close the http server before the others to
        // ensure that e.g. if something goes wrong and we deadlock, then if
        // we're running in k8s, the liveness check will fail, and thus k8s will
        // kill the pod.
        //
        // I say hacky because we've got a weak dependency on the liveness check
        // configuration.
        httpServer?.close()
        cancelAllScheduledJobs()
        stopEventLoopMetrics?.()
        await Promise.allSettled([
            pubSub?.stop(),
            graphileWorker?.stop(),
            analyticsEventsIngestionConsumer?.stop(),
            analyticsEventsIngestionOverflowConsumer?.stop(),
            onEventHandlerConsumer?.stop(),
            webhooksHandlerConsumer?.stop(),
            bufferConsumer?.disconnect(),
            jobsConsumer?.disconnect(),
            stopSessionRecordingEventsConsumer?.(),
            stopSessionRecordingBlobConsumer?.(),
            schedulerTasksConsumer?.disconnect(),
        ])

        if (piscina) {
            await stopPiscina(piscina)
        }

        await closeHub?.()

        status.info('👋', 'Over and out!')
    }

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, () => process.emit('beforeExit', 0))
    }

    process.on('beforeExit', async () => {
        // This makes async exit possible with the process waiting until jobs are closed
        status.info('👋', 'process handling beforeExit event. Closing jobs...')
        await closeJobs()
        process.exit(0)
    })

    // Code list in https://kafka.apache.org/0100/protocol.html
    const kafkaJSIgnorableCodes = new Set([
        22, // ILLEGAL_GENERATION
        25, // UNKNOWN_MEMBER_ID
        27, // REBALANCE_IN_PROGRESS
    ])

    process.on('unhandledRejection', (error: Error) => {
        status.error('🤮', `Unhandled Promise Rejection: ${error.stack}`)

        if (error instanceof KafkaJSProtocolError) {
            kafkaProtocolErrors.inc({
                type: error.type,
                code: error.code,
            })

            // Ignore some "business as usual" Kafka errors, send the rest to sentry
            if (error.code in kafkaJSIgnorableCodes) {
                return
            }
        }

        Sentry.captureException(error, {
            extra: { detected_at: `pluginServer.ts on unhandledRejection` },
        })
    })

    process.on('uncaughtException', async (error: Error) => {
        // If there are unhandled exceptions anywhere, perform a graceful
        // shutdown. The initial trigger for including this handler is due to
        // the graphile-worker code throwing an exception when it can't call
        // `nudge` on a worker. Unsure as to why this happens, but at any rate,
        // to ensure that we gracefully shutdown Kafka consumers, for which
        // unclean shutdowns can cause considerable delay in starting to consume
        // again, we try to gracefully shutdown.
        //
        // See https://nodejs.org/api/process.html#event-uncaughtexception for
        // details on the handler.
        if (shuttingDown) {
            return
        }
        status.error('🤮', `uncaught_exception`, { error: error.stack })
        await closeJobs()

        process.exit(1)
    })

    capabilities = capabilities ?? getPluginServerCapabilities(serverConfig)
    let serverInstance: (Partial<ServerInstance> & Pick<ServerInstance, 'hub'>) | undefined

    // A collection of healthchecks that should be used to validate the
    // health of the plugin-server. These are used by the /_health endpoint
    // to determine if we should trigger a restart of the pod. These should
    // be super lightweight and ideally not do any IO.
    const healthChecks: { [service: string]: () => Promise<boolean> | boolean } = {}

    try {
        // Based on the mode the plugin server was started, we start a number of
        // different services. Mostly this is reasonably obvious from the name.
        // There is however the `queue` which is a little more complicated.
        // Depending on the capabilities we start with, it will either consume
        // from:
        //
        // 1. plugin_events_ingestion
        // 2. clickhouse_events_json
        // 3. clickhouse_events_json and plugin_events_ingestion
        // 4. conversion_events_buffer
        //
        if (capabilities.processPluginJobs || capabilities.pluginScheduledTasks) {
            ;[hub, closeHub] = hub ? [hub, closeHub] : await createHub(serverConfig, null, capabilities)
            serverInstance = serverInstance ? serverInstance : { hub }

            graphileWorker = new GraphileWorker(hub)
            // `connectProducer` just runs the PostgreSQL migrations. Ideally it
            // would be great to move the migration to bin/migrate and ensure we
            // have a way for the pods to wait for the migrations to complete as
            // we do with other migrations. However, I couldn't find a
            // `graphile-worker` supported way to do this, and I don't think
            // it's that heavy so it may be fine, but something to watch out
            // for.
            await graphileWorker.connectProducer()
            piscina = piscina ?? (await makePiscina(serverConfig, hub))
            status.info('👷', 'Starting graphile worker...')
            await startGraphileWorker(hub, graphileWorker, piscina)
            status.info('👷', 'Graphile worker is ready!')

            if (capabilities.pluginScheduledTasks) {
                schedulerTasksConsumer = await startScheduledTasksConsumer({
                    piscina: piscina,
                    producer: hub.kafkaProducer,
                    kafka: hub.kafka,
                    partitionConcurrency: serverConfig.KAFKA_PARTITIONS_CONSUMED_CONCURRENTLY,
                    statsd: hub.statsd,
                })
            }

            if (capabilities.processPluginJobs) {
                jobsConsumer = await startJobsConsumer({
                    kafka: hub.kafka,
                    producer: hub.kafkaProducer,
                    graphileWorker: graphileWorker,
                    statsd: hub.statsd,
                })
            }
        }

        if (capabilities.ingestion) {
            ;[hub, closeHub] = hub ? [hub, closeHub] : await createHub(serverConfig, null, capabilities)
            serverInstance = serverInstance ? serverInstance : { hub }

            piscina = piscina ?? (await makePiscina(serverConfig, hub))
            const { queue, isHealthy: isAnalyticsEventsIngestionHealthy } = await startAnalyticsEventsIngestionConsumer(
                {
                    hub: hub,
                    piscina: piscina,
                }
            )

            analyticsEventsIngestionConsumer = queue
            healthChecks['analytics-ingestion'] = isAnalyticsEventsIngestionHealthy
        }

        if (capabilities.ingestionOverflow) {
            ;[hub, closeHub] = hub ? [hub, closeHub] : await createHub(serverConfig, null, capabilities)
            serverInstance = serverInstance ? serverInstance : { hub }

            piscina = piscina ?? (await makePiscina(serverConfig, hub))
            analyticsEventsIngestionOverflowConsumer = await startAnalyticsEventsIngestionOverflowConsumer({
                hub: hub,
                piscina: piscina,
            })
        }

        // TODO: remove once onevent and webhooks split is fully out
        if (capabilities.processAsyncHandlers) {
            ;[hub, closeHub] = hub ? [hub, closeHub] : await createHub(serverConfig, null, capabilities)
            serverInstance = serverInstance ? serverInstance : { hub }

            piscina = piscina ?? (await makePiscina(serverConfig, hub))
            const { queue: onEventQueue, isHealthy: isOnEventsIngestionHealthy } = await startAsyncHandlerConsumer({
                hub: hub,
                piscina: piscina,
            })

            onEventHandlerConsumer = onEventQueue

            healthChecks['on-event-ingestion'] = isOnEventsIngestionHealthy
        }
        if (capabilities.processAsyncOnEventHandlers) {
            if (capabilities.processAsyncHandlers) {
                throw Error('async and onEvent together are not allowed - would export twice')
            }
            ;[hub, closeHub] = hub ? [hub, closeHub] : await createHub(serverConfig, null, capabilities)
            serverInstance = serverInstance ? serverInstance : { hub }

            piscina = piscina ?? (await makePiscina(serverConfig, hub))
            const { queue: onEventQueue, isHealthy: isOnEventsIngestionHealthy } =
                await startAsyncOnEventHandlerConsumer({
                    hub: hub,
                    piscina: piscina,
                })

            onEventHandlerConsumer = onEventQueue

            healthChecks['on-event-ingestion'] = isOnEventsIngestionHealthy
        }
        if (capabilities.processAsyncWebhooksHandlers) {
            if (capabilities.processAsyncHandlers) {
                throw Error('async and webhooks together are not allowed - would send twice')
            }
            ;[hub, closeHub] = hub ? [hub, closeHub] : await createHub(serverConfig, null, capabilities)
            serverInstance = serverInstance ? serverInstance : { hub }

            piscina = piscina ?? (await makePiscina(serverConfig, hub))
            const { queue: webhooksQueue, isHealthy: isWebhooksIngestionHealthy } =
                await startAsyncWebhooksHandlerConsumer({
                    hub: hub,
                    piscina: piscina,
                })

            webhooksHandlerConsumer = webhooksQueue

            healthChecks['webhooks-ingestion'] = isWebhooksIngestionHealthy
        }

        // If we have
        if (hub && serverInstance) {
            pubSub = new PubSub(hub, {
                [hub.PLUGINS_RELOAD_PUBSUB_CHANNEL]: async () => {
                    status.info('⚡', 'Reloading plugins!')
                    await piscina?.broadcastTask({ task: 'reloadPlugins' })

                    if (hub?.capabilities.pluginScheduledTasks && piscina) {
                        await piscina.broadcastTask({ task: 'reloadSchedule' })
                        hub.pluginSchedule = await loadPluginSchedule(piscina)
                    }
                },
                'reset-available-features-cache': async (message) => {
                    await piscina?.broadcastTask({ task: 'resetAvailableFeaturesCache', args: JSON.parse(message) })
                },
                ...(capabilities.processAsyncHandlers || capabilities.processAsyncWebhooksHandlers
                    ? {
                          'reload-action': async (message) =>
                              await piscina?.broadcastTask({ task: 'reloadAction', args: JSON.parse(message) }),
                          'drop-action': async (message) =>
                              await piscina?.broadcastTask({ task: 'dropAction', args: JSON.parse(message) }),
                      }
                    : {}),
            })

            await pubSub.start()

            // every 5 minutes all ActionManager caches are reloaded for eventual consistency
            schedule.scheduleJob('*/5 * * * *', async () => {
                await piscina?.broadcastTask({ task: 'reloadAllActions' })
            })

            startPreflightSchedules(hub)

            if (hub.statsd) {
                stopEventLoopMetrics = captureEventLoopMetrics(hub.statsd, hub.instanceId)
            }

            serverInstance.piscina = piscina
            serverInstance.queue = analyticsEventsIngestionConsumer
            serverInstance.stop = closeJobs

            hub.statsd?.timing('total_setup_time', timer)
            status.info('🚀', 'All systems go')

            hub.lastActivity = new Date().valueOf()
            hub.lastActivityType = 'serverStart'
        }

        if (capabilities.sessionRecordingIngestion) {
            const postgres = hub?.postgres ?? createPostgresPool(serverConfig.DATABASE_URL)
            const teamManager = hub?.teamManager ?? new TeamManager(postgres, serverConfig)
            const {
                stop,
                isHealthy: isSessionRecordingsHealthy,
                join,
            } = await startSessionRecordingEventsConsumer({
                teamManager: teamManager,
                kafkaConfig: serverConfig,
                consumerMaxBytes: serverConfig.KAFKA_CONSUMPTION_MAX_BYTES,
                consumerMaxBytesPerPartition: serverConfig.KAFKA_CONSUMPTION_MAX_BYTES_PER_PARTITION,
                consumerMaxWaitMs: serverConfig.KAFKA_CONSUMPTION_MAX_WAIT_MS,
                consumerErrorBackoffMs: serverConfig.KAFKA_CONSUMPTION_ERROR_BACKOFF_MS,
                batchingTimeoutMs: serverConfig.KAFKA_CONSUMPTION_BATCHING_TIMEOUT_MS,
            })
            stopSessionRecordingEventsConsumer = stop
            joinSessionRecordingEventsConsumer = join
            healthChecks['session-recordings'] = isSessionRecordingsHealthy
        }

        if (capabilities.sessionRecordingBlobIngestion) {
            const blobServerConfig = sessionRecordingBlobConsumerConfig(serverConfig)
            const postgres = hub?.postgres ?? createPostgresPool(blobServerConfig.DATABASE_URL)
            const teamManager = hub?.teamManager ?? new TeamManager(postgres, blobServerConfig)
            const s3 = hub?.objectStorage ?? getObjectStorage(blobServerConfig)
            const redisPool = hub?.db.redisPool ?? createRedisPool(blobServerConfig)

            if (!s3) {
                throw new Error("Can't start session recording blob ingestion without object storage")
            }
            const ingester = new SessionRecordingBlobIngester(teamManager, blobServerConfig, s3, redisPool)
            await ingester.start()
            const batchConsumer = ingester.batchConsumer
            if (batchConsumer) {
                stopSessionRecordingBlobConsumer = async () => {
                    // Tricky - in some cases the hub is responsible, in which case it will drain and clear. Otherwise we are responsible.
                    if (!hub?.db.redisPool) {
                        await redisPool.drain()
                        await redisPool.clear()
                    }

                    await ingester.stop()
                }
                joinSessionRecordingBlobConsumer = () => batchConsumer.join()
                healthChecks['session-recordings-blob'] = () => batchConsumer.isHealthy() ?? false
            }
        }

        if (capabilities.http) {
            httpServer = createHttpServer(healthChecks, analyticsEventsIngestionConsumer)
        }

        // If session recordings consumer is defined, then join it. If join
        // resolves, then the consumer has stopped and we should shut down
        // everything else. Ideally we would also join all the other background
        // tasks as well to ensure we stop the server if we hit any errors and
        // don't end up with zombie instances, but I'll leave that refactoring
        // for another time. Note that we have the liveness health checks
        // already, so in K8s cases zombies should be reaped anyway, albeit not
        // in the most efficient way.
        //
        // When extending to other consumers, we would want to do something like
        //
        // ```
        // try {
        //      await Promise.race([sessionConsumer.join(), analyticsConsumer.join(), ...])
        // } finally {
        //      await closeJobs()
        // }
        // ```
        if (joinSessionRecordingEventsConsumer) {
            joinSessionRecordingEventsConsumer().catch(closeJobs)
        }
        if (joinSessionRecordingBlobConsumer) {
            joinSessionRecordingBlobConsumer().catch(closeJobs)
        }

        return serverInstance ?? { stop: closeJobs }
    } catch (error) {
        Sentry.captureException(error)
        status.error('💥', 'Launchpad failure!', { error: error.stack ?? error })
        void Sentry.flush().catch(() => null) // Flush Sentry in the background
        status.error('💥', 'Exception while starting server, shutting down!', { error })
        await closeJobs()
        process.exit(1)
    }
}

const startPreflightSchedules = (hub: Hub) => {
    // These are used by the preflight checks in the Django app to determine if
    // the plugin-server is running.
    schedule.scheduleJob('*/5 * * * * *', async () => {
        await hub.db.redisSet('@posthog-plugin-server/ping', new Date().toISOString(), 60, {
            jsonSerialize: false,
        })
        await hub.db.redisSet('@posthog-plugin-server/version', version, undefined, { jsonSerialize: false })
    })
}

export async function stopPiscina(piscina: Piscina): Promise<void> {
    // Wait *up to* 5 seconds to shut down VMs.
    await Promise.race([piscina.broadcastTask({ task: 'teardownPlugins' }), delay(5000)])
    // Wait 2 seconds to flush the last queues and caches
    await Promise.all([piscina.broadcastTask({ task: 'flushKafkaMessages' }), delay(2000)])
}

const kafkaProtocolErrors = new Counter({
    name: 'kafka_protocol_errors_total',
    help: 'Kafka protocol errors encountered, by type',
    labelNames: ['type', 'code'],
})
