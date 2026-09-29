import { createRequire } from 'node:module';
import { loadConfig, redactor } from './config.mjs';
import { createService } from './service.mjs';
import { logJson } from './app.mjs';

const config = loadConfig();
const breez = createRequire(import.meta.url)('@breeztech/breez-sdk-spark');
const redact = redactor(config);
const log = (entry) => logJson(entry, redact);
const service = createService({ config, breez, log });

// The SDK leaves handles open after disconnect, so exit explicitly.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => service.stop(signal).then(({ ok }) => process.exit(ok ? 0 : 1)));
}
service.started.catch((e) => {
  log({ event: 'start-failed', error: String(e?.message ?? e).slice(0, 300) });
  process.exit(1);
});
