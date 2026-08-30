import 'reflect-metadata';
import { Logger } from '@nestjs/common';

// Tests must never inherit a developer's real configuration: a stray
// `CR_API_DATABASE__URL` in the shell would otherwise point the suite at a live
// database. Each suite sets what it needs explicitly.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CR_API_')) {
    delete process.env[key];
  }
}

process.env.NODE_ENV ??= 'test';

// Keep failures visible without the boot banner drowning the report.
Logger.overrideLogger(['error', 'fatal']);
