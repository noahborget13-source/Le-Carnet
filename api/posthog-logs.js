import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';

const token = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;
let provider;
let logger;

if (!token || !host) {
  const missingVariable = !token ? 'POSTHOG_PROJECT_TOKEN' : 'POSTHOG_HOST';
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`);
  }
} else {
  try {
    const exporter = new OTLPLogExporter({
      url: new URL('/i/v1/logs', host).toString(),
      headers: { Authorization: `Bearer ${token}` },
      timeoutMillis: 2000,
    });
    provider = new LoggerProvider({
      resource: resourceFromAttributes({ 'service.name': 'le-carnet-api' }),
      processors: [new BatchLogRecordProcessor(exporter, { exportTimeoutMillis: 2000 })],
    });
    logger = provider.getLogger('le-carnet-posthog');
  } catch (_) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_HOST is configured');
    }
  }
}

export function emitPosthogLog(severityText, body, attributes = {}) {
  logger?.emit({ severityText, body, attributes });
}

export async function flushPosthogLogs() {
  if (provider) await provider.forceFlush().catch(() => {});
}
