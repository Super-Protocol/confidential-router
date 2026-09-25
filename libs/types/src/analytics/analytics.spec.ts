/**
 * Contract test: the analytics taxonomy is well-formed, says the same thing as the typed view beside
 * it, and says the same thing as the document humans read.
 *
 * The taxonomy is the one contract in this repository whose other implementation lives in a different
 * repository (`confidential-router-landing`, SUP-144), so nothing but a test holds the names together.
 * It is read from the repository root for the same reason `schemas.spec.ts` reads its schemas there.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020Module, { type ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_EVENT_PROPERTIES,
  ANALYTICS_EVENT_SURFACE,
  ANALYTICS_EVENTS,
  type AnalyticsEventName,
  CONSOLE_INGEST_EVENTS,
  isAnalyticsEventName,
  isAnalyticsProperty,
  isConsoleIngestEventName,
} from './events.js';

// ajv and ajv-formats are CommonJS; under `nodenext` the constructor lives on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = ajvFormats.default;

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..', '..', '..');
const SCHEMAS_DIR = join(REPO_ROOT, 'schemas');

interface PropertyDefinition {
  type: 'string' | 'integer' | 'boolean';
  required: boolean;
  description: string;
  enum?: string[];
  example?: string | number | boolean;
}

interface EventDefinition {
  name: string;
  surface: 'landing' | 'console' | 'api';
  tool: 'plausible' | 'posthog';
  transport: 'browser' | 'server' | 'first-party-ingest';
  owner: string;
  when: string;
  notes?: string;
  uses?: string[];
  properties?: Record<string, PropertyDefinition>;
}

interface Taxonomy {
  version: number;
  sharedProperties: Record<string, PropertyDefinition>;
  events: EventDefinition[];
}

const taxonomy = JSON.parse(readFileSync(join(SCHEMAS_DIR, 'analytics-taxonomy.json'), 'utf8')) as Taxonomy;
const taxonomyDoc = readFileSync(join(REPO_ROOT, 'docs', 'contracts', 'analytics-events.md'), 'utf8');

function compile(schemaFile: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(SCHEMAS_DIR, schemaFile), 'utf8')));
}

function errorsOf(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}

/** Every property name an event carries, shared ones included. */
function propertiesOf(event: EventDefinition): string[] {
  return [...(event.uses ?? []), ...Object.keys(event.properties ?? {})].sort();
}

describe('analytics-taxonomy.schema.json', () => {
  const validate = compile('analytics-taxonomy.schema.json');

  it('compiles in strict mode', () => {
    expect(validate).toBeTypeOf('function');
  });

  it('validates analytics-taxonomy.json', () => {
    expect(validate(taxonomy), errorsOf(validate)).toBe(true);
  });

  it('rejects an event with no owning issue', () => {
    const doc = structuredClone(taxonomy) as Record<string, any>;
    doc.events[0].owner = 'later';
    expect(validate(doc)).toBe(false);
  });

  it('rejects a landing event routed to PostHog', () => {
    const doc = structuredClone(taxonomy) as Record<string, any>;
    const landing = doc.events.find((e: EventDefinition) => e.surface === 'landing');
    landing.tool = 'posthog';
    expect(validate(doc)).toBe(false);
  });

  it('rejects a console event that would call PostHog from the browser', () => {
    const doc = structuredClone(taxonomy) as Record<string, any>;
    const console_ = doc.events.find((e: EventDefinition) => e.surface === 'console');
    console_.transport = 'browser';
    expect(validate(doc)).toBe(false);
  });

  it('rejects a nested property type', () => {
    const doc = structuredClone(taxonomy) as Record<string, any>;
    doc.sharedProperties.campaign.type = 'object';
    expect(validate(doc)).toBe(false);
  });

  it('rejects CamelCase names', () => {
    const doc = structuredClone(taxonomy) as Record<string, any>;
    doc.events[0].name = 'landingView';
    expect(validate(doc)).toBe(false);
  });
});

describe('taxonomy rules', () => {
  it('declares every shared property it references', () => {
    const shared = new Set(Object.keys(taxonomy.sharedProperties));
    for (const event of taxonomy.events) {
      for (const name of event.uses ?? []) {
        expect(shared, `${event.name} uses an undeclared shared property`).toContain(name);
      }
    }
  });

  it('uses every shared property it declares', () => {
    const used = new Set(taxonomy.events.flatMap((e) => e.uses ?? []));
    for (const name of Object.keys(taxonomy.sharedProperties)) {
      expect(used, `${name} is declared and never used`).toContain(name);
    }
  });

  it('never redefines a shared property on an event', () => {
    const shared = new Set(Object.keys(taxonomy.sharedProperties));
    for (const event of taxonomy.events) {
      for (const name of Object.keys(event.properties ?? {})) {
        expect(shared, `${event.name}.${name} shadows a shared property`).not.toContain(name);
      }
    }
  });

  it('names each event exactly once', () => {
    const names = taxonomy.events.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The taxonomy is the list of everything the two tools are allowed to see, and the product's claim is
   * that prompts are unreadable. A property whose name announces personal data would not be caught by a
   * schema — nothing about `email: string` is malformed — so it is caught here, where adding one means
   * arguing with a test in the same pull request that adds it.
   */
  it('carries no property that names personal data', () => {
    const forbidden = [
      'email',
      'name',
      'phone',
      'address',
      'ip',
      'user',
      'agent',
      'password',
      'secret',
      'token',
      'prompt',
      'completion',
      'message',
      'content',
      'query',
      'text',
      'note',
      'body',
      'referrer',
    ];
    const definitions: [string, PropertyDefinition][] = [
      ...Object.entries(taxonomy.sharedProperties),
      ...taxonomy.events.flatMap((e) => Object.entries(e.properties ?? {})),
    ];

    for (const [property, definition] of definitions) {
      // A boolean cannot carry the thing it is named after: `has_details` says whether a note exists,
      // it does not contain one.
      if (definition.type === 'boolean') continue;
      // `utm_*` is the string we put in our own mailing URL, not something the visitor wrote.
      if (property.startsWith('utm_')) continue;
      for (const segment of property.split('_')) {
        expect(forbidden, `${property} reads like personal data`).not.toContain(segment);
      }
    }
  });

  it('gives every closed-set property an example drawn from its own set', () => {
    const definitions: PropertyDefinition[] = [
      ...Object.values(taxonomy.sharedProperties),
      ...taxonomy.events.flatMap((e) => Object.values(e.properties ?? {})),
    ];
    for (const definition of definitions) {
      if (definition.enum && definition.example !== undefined) {
        expect(definition.enum).toContain(definition.example);
      }
    }
  });

  it('keeps an optional `reason` beside every `outcome`', () => {
    for (const event of taxonomy.events) {
      if (!(event.uses ?? []).includes('outcome')) continue;
      const reason = event.properties?.reason;
      expect(reason, `${event.name} reports an outcome with no reason`).toBeDefined();
      expect(reason?.required).toBe(false);
    }
  });
});

describe('typed view vs. the taxonomy', () => {
  it('lists the same events, in the same order', () => {
    expect([...ANALYTICS_EVENTS]).toEqual(taxonomy.events.map((e) => e.name));
  });

  it('agrees on every event surface', () => {
    for (const event of taxonomy.events) {
      expect(ANALYTICS_EVENT_SURFACE[event.name as AnalyticsEventName], event.name).toBe(event.surface);
    }
  });

  it('agrees on every property, in both directions', () => {
    for (const event of taxonomy.events) {
      const declared = [...ANALYTICS_EVENT_PROPERTIES[event.name as AnalyticsEventName]].sort();
      expect(declared, event.name).toEqual(propertiesOf(event));
    }
  });

  it('opens the first-party ingest to exactly the console events', () => {
    const consoleEvents = taxonomy.events.filter((e) => e.transport === 'first-party-ingest').map((e) => e.name);
    expect([...CONSOLE_INGEST_EVENTS].sort()).toEqual(consoleEvents.sort());
  });

  it('recognises its own names and nothing else', () => {
    expect(isAnalyticsEventName('first_request_sent')).toBe(true);
    expect(isAnalyticsEventName('firstRequestSent')).toBe(false);
    expect(isAnalyticsEventName(42)).toBe(false);
    expect(isConsoleIngestEventName('signup_started')).toBe(true);
    // Server-side truth a browser must not be able to assert.
    expect(isConsoleIngestEventName('invite_redeemed')).toBe(false);
  });

  it('recognises its own properties and nothing else', () => {
    expect(isAnalyticsProperty('invite_redeemed', 'campaign')).toBe(true);
    expect(isAnalyticsProperty('invite_redeemed', 'email')).toBe(false);
    expect(isAnalyticsProperty('faq_opened', 'campaign')).toBe(false);
  });
});

describe('the document humans read', () => {
  it('has a row for every event', () => {
    for (const event of taxonomy.events) {
      expect(taxonomyDoc, `${event.name} is not in docs/contracts/analytics-events.md`).toContain(`\`${event.name}\``);
    }
  });

  it('has a row for every property', () => {
    const names = [
      ...Object.keys(taxonomy.sharedProperties),
      ...taxonomy.events.flatMap((e) => Object.keys(e.properties ?? {})),
    ];
    for (const property of new Set(names)) {
      expect(taxonomyDoc, `${property} is not in docs/contracts/analytics-events.md`).toContain(`\`${property}\``);
    }
  });

  /** The funnel the launch is judged on (ADR-006 §5). If a step is renamed, this is what notices. */
  it('still has every step of the launch funnel', () => {
    for (const step of [
      'landing_view',
      'cta_click',
      'signup_completed',
      'invite_redeemed',
      'first_request_sent',
    ] as const) {
      expect(ANALYTICS_EVENTS).toContain(step);
    }
  });
});
