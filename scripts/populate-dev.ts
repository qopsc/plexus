/**
 * populate-dev.ts
 *
 * Seeds a running Plexus instance with a realistic baseline configuration for
 * development and testing. Does NOT require any real external API credentials
 * by default — all providers point at local or mock endpoints.
 *
 * Also drives real traffic through the gateway (using a fake upstream LLM
 * backend, scripts/mock-upstream.ts, started automatically on :4010) so the
 * Dashboard, Logs, Errors, and Debug pages — which read from tables only the
 * real dispatcher writes to — have data too, not just Providers/Aliases/Keys.
 *
 * Usage:
 *   bun run scripts/populate-dev.ts
 *
 * Environment variables (all optional — defaults match `bun run dev` defaults):
 *   PLEXUS_URL          Base URL of the Plexus instance  (default: http://localhost)
 *   PLEXUS_PORT         Port                             (default: 4000)
 *   PLEXUS_ADMIN_KEY    Admin key                        (default: password)
 *   MOCK_UPSTREAM_PORT  Fake LLM backend port            (default: 4010)
 *   PLEXUS_SKIP_TRAFFIC Set to '1' to skip traffic generation (config only)
 *
 * Data sources (applied in order — later entries win on name collision):
 *   scripts/default-populate.json   — committed default fixtures (no secrets)
 *   scripts/user-populate.json      — optional local overrides (git-ignored)
 */

import { join, basename } from 'path';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const BASE_URL = process.env.PLEXUS_URL ?? 'http://localhost';
const ADMIN_KEY = process.env.PLEXUS_ADMIN_KEY ?? 'password';

// Mirrors the stable port derivation in scripts/dev.ts so this script targets
// the correct worktree instance without any configuration.
function deriveDevPort(): string {
  const dirName = basename(process.cwd());
  let hash = 5381;
  for (let i = 0; i < dirName.length; i++) {
    hash = (hash * 33) ^ dirName.charCodeAt(i);
  }
  return String(10000 + (Math.abs(hash) % 10000));
}

const PORT = process.env.PLEXUS_PORT ?? deriveDevPort();

const API_ROOT = `${BASE_URL}:${PORT}`;

// ---------------------------------------------------------------------------
// Types mirroring the OpenAPI schemas
// ---------------------------------------------------------------------------

interface ProviderConfig {
  type: string;
  base_url?: string;
  api_key?: string;
  disable_cooldown?: boolean;
  gpu_ram_gb?: number;
  gpu_bandwidth_tb_s?: number;
  gpu_flops_tflop?: number;
  gpu_power_draw_watts?: number;
  [key: string]: unknown;
}

interface UserQuotaDefinition {
  type: 'rolling' | 'daily' | 'weekly';
  limitType: 'requests' | 'tokens';
  limit: number;
  duration?: string;
}

interface AliasTarget {
  provider: string;
  model: string;
}

interface AliasConfig {
  type:
    | 'chat'
    | 'messages'
    | 'responses'
    | 'gemini'
    | 'embeddings'
    | 'transcriptions'
    | 'speech'
    | 'image';
  targets: AliasTarget[];
  additional_aliases?: string[];
  input_price_per_million?: number;
  output_price_per_million?: number;
  metadata?: Record<string, unknown>;
  model_architecture?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
}

interface KeyConfig {
  secret: string;
  comment?: string;
  allowedProviders?: string[];
  allowedModels?: string[];
  quota?: string | null;
}

interface McpServerConfig {
  upstream_url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
}

interface PopulateFile {
  providers?: Record<string, ProviderConfig>;
  quotas?: Record<string, UserQuotaDefinition>;
  aliases?: Record<string, AliasConfig>;
  keys?: Record<string, KeyConfig>;
  mcpServers?: Record<string, McpServerConfig>;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const adminHeaders = {
  'Content-Type': 'application/json',
  'x-admin-key': ADMIN_KEY,
};

async function apiPut(
  path: string,
  body: unknown
): Promise<{ ok: boolean; status: number; text: string }> {
  const url = `${API_ROOT}${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function apiPatch(
  path: string,
  body: unknown
): Promise<{ ok: boolean; status: number; text: string }> {
  const url = `${API_ROOT}${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

// ---------------------------------------------------------------------------
// Load and merge populate files
// ---------------------------------------------------------------------------

async function loadPopulateFile(filePath: string): Promise<PopulateFile | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const raw = await file.text();
    return JSON.parse(raw) as PopulateFile;
  } catch (err) {
    console.error(
      `  ⚠  Failed to load ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

function mergePopulateFiles(...sources: (PopulateFile | null)[]): PopulateFile {
  const merged: PopulateFile = {
    providers: {},
    quotas: {},
    aliases: {},
    keys: {},
    mcpServers: {},
  };
  for (const source of sources) {
    if (!source) continue;
    if (source.providers) Object.assign(merged.providers!, source.providers);
    if (source.quotas) Object.assign(merged.quotas!, source.quotas);
    if (source.aliases) Object.assign(merged.aliases!, source.aliases);
    if (source.keys) Object.assign(merged.keys!, source.keys);
    if (source.mcpServers) Object.assign(merged.mcpServers!, source.mcpServers);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Seeding functions
// ---------------------------------------------------------------------------

type Result = { name: string; ok: boolean; status: number; detail?: string };

async function seedProviders(providers: Record<string, ProviderConfig>): Promise<Result[]> {
  const results: Result[] = [];
  for (const [slug, config] of Object.entries(providers)) {
    const { ok, status, text } = await apiPut(
      `/v0/management/providers/${encodeURIComponent(slug)}`,
      config
    );
    results.push({ name: slug, ok, status, detail: ok ? undefined : text });
  }
  return results;
}

async function seedQuotas(quotas: Record<string, UserQuotaDefinition>): Promise<Result[]> {
  const results: Result[] = [];
  for (const [name, definition] of Object.entries(quotas)) {
    const { ok, status, text } = await apiPut(
      `/v0/management/user-quotas/${encodeURIComponent(name)}`,
      definition
    );
    results.push({ name, ok, status, detail: ok ? undefined : text });
  }
  return results;
}

async function seedAliases(aliases: Record<string, AliasConfig>): Promise<Result[]> {
  const results: Result[] = [];
  for (const [slug, config] of Object.entries(aliases)) {
    const { ok, status, text } = await apiPut(
      `/v0/management/aliases/${encodeURIComponent(slug)}`,
      config
    );
    results.push({ name: slug, ok, status, detail: ok ? undefined : text });
  }
  return results;
}

async function seedKeys(keys: Record<string, KeyConfig>): Promise<Result[]> {
  const results: Result[] = [];
  for (const [name, config] of Object.entries(keys)) {
    const { ok, status, text } = await apiPut(
      `/v0/management/keys/${encodeURIComponent(name)}`,
      config
    );
    results.push({ name, ok, status, detail: ok ? undefined : text });
  }
  return results;
}

async function seedMcpServers(servers: Record<string, McpServerConfig>): Promise<Result[]> {
  const results: Result[] = [];
  for (const [name, config] of Object.entries(servers)) {
    const { ok, status, text } = await apiPut(
      `/v0/management/mcp-servers/${encodeURIComponent(name)}`,
      config
    );
    results.push({ name, ok, status, detail: ok ? undefined : text });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Traffic generation — the Dashboard, Logs, Errors, and Debug pages all read
// from tables (request_usage, inference_errors, debug_logs) that are only
// written by the real inference dispatcher, never by a management PUT. The
// only way to populate them for dev is to drive actual requests through the
// gateway. That in turn requires a live upstream for the mock-* providers,
// so we spin up a tiny fake LLM backend (scripts/mock-upstream.ts) on demand.
// ---------------------------------------------------------------------------

const MOCK_UPSTREAM_PORT = process.env.MOCK_UPSTREAM_PORT ?? '4010';
const MOCK_UPSTREAM_URL = `http://localhost:${MOCK_UPSTREAM_PORT}`;

async function isMockUpstreamRunning(): Promise<boolean> {
  try {
    await fetch(MOCK_UPSTREAM_URL, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function ensureMockUpstream(): Promise<'already-running' | 'started' | 'failed'> {
  if (await isMockUpstreamRunning()) return 'already-running';

  Bun.spawn(['bun', 'run', join(import.meta.dir, 'mock-upstream.ts')], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, MOCK_UPSTREAM_PORT },
  }).unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await isMockUpstreamRunning()) return 'started';
  }
  return 'failed';
}

async function enableDebugCapture(): Promise<boolean> {
  const { ok } = await apiPatch('/v0/management/debug', { enabled: true });
  return ok;
}

const SAMPLE_PROMPTS = [
  'Summarize the plot of a mystery novel in three sentences.',
  'Write a short haiku about distributed systems.',
  'Explain the CAP theorem to a new engineer.',
  'What are the tradeoffs between REST and gRPC?',
  'Draft a friendly reminder email about an upcoming deadline.',
  'List three edge cases to test for a login form.',
  'Explain what a bloom filter is used for.',
  'Suggest a name for a coffee shop near a university.',
  'Compare SQLite and Postgres for a small side project.',
  'Write a one-paragraph product description for noise-cancelling headphones.',
];

async function fireChatCompletion(
  secret: string,
  model: string,
  prompt: string
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(`${API_ROOT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
      signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function generateTraffic(
  keys: Record<string, KeyConfig>,
  aliases: Record<string, AliasConfig>,
  rounds = 40
): Promise<{ total: number; ok: number; failed: number }> {
  const chatAliases = Object.entries(aliases)
    .filter(([, cfg]) => cfg.type === 'chat')
    .map(([name]) => name);
  const keySecrets = Object.values(keys).map((k) => k.secret);

  if (chatAliases.length === 0 || keySecrets.length === 0) {
    return { total: 0, ok: 0, failed: 0 };
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < rounds; i++) {
    const secret = keySecrets[i % keySecrets.length]!;
    const model = chatAliases[i % chatAliases.length]!;
    const prompt = SAMPLE_PROMPTS[i % SAMPLE_PROMPTS.length]!;
    const result = await fireChatCompletion(secret, model, prompt);
    if (result.ok) ok++;
    else failed++;
  }
  return { total: rounds, ok, failed };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSection(label: string, results: Result[]): void {
  const ok = results.filter((r) => r.ok).length;
  const err = results.filter((r) => !r.ok).length;
  const icon = err === 0 ? '✓' : '✗';
  console.log(`\n  ${icon}  ${label}: ${ok} ok${err > 0 ? `, ${err} failed` : ''}`);
  for (const r of results) {
    if (r.ok) {
      console.log(`       ✓  ${r.name}`);
    } else {
      console.log(`       ✗  ${r.name} [${r.status}] ${r.detail ?? ''}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Connectivity check
// ---------------------------------------------------------------------------

async function checkConnectivity(): Promise<void> {
  const healthUrl = `${API_ROOT}/health`;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.error(`  ✗  Health check failed: HTTP ${res.status} from ${healthUrl}`);
      console.error('     Is the Plexus server running? Try: bun run dev');
      process.exit(1);
    }
  } catch (err) {
    console.error(`  ✗  Cannot reach Plexus at ${healthUrl}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    console.error('\n     Is the server running? Try: bun run dev');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('╔════════════════════════════════════════╗');
console.log('║       Plexus Dev Populate Script       ║');
console.log('╚════════════════════════════════════════╝');
console.log(`\n  Target:    ${API_ROOT}`);
console.log(
  `  Admin key: ${ADMIN_KEY.slice(0, 4)}${'*'.repeat(Math.max(0, ADMIN_KEY.length - 4))}`
);

// Connectivity
process.stdout.write('\n  Checking connectivity...');
await checkConnectivity();
console.log(' ok\n');

// Load data files
const scriptsDir = join(import.meta.dir);
const defaultFile = join(scriptsDir, 'default-populate.json');
const userFile = join(scriptsDir, 'user-populate.json');

const defaultData = await loadPopulateFile(defaultFile);
const userData = await loadPopulateFile(userFile);

if (!defaultData) {
  console.error(`  ✗  Could not load ${defaultFile}`);
  process.exit(1);
}

if (userData) {
  console.log('  ℹ  user-populate.json found — merging over defaults');
} else {
  console.log('  ℹ  No user-populate.json found — using defaults only');
}

const data = mergePopulateFiles(defaultData, userData);

const providerCount = Object.keys(data.providers ?? {}).length;
const quotaCount = Object.keys(data.quotas ?? {}).length;
const aliasCount = Object.keys(data.aliases ?? {}).length;
const keyCount = Object.keys(data.keys ?? {}).length;
const mcpServerCount = Object.keys(data.mcpServers ?? {}).length;

console.log(
  `\n  Plan: ${providerCount} provider(s), ${quotaCount} quota(s), ${aliasCount} alias(es), ${keyCount} key(s), ${mcpServerCount} MCP server(s)`
);
console.log('  Note: quotas must exist before keys that reference them\n');

// Seed — order matters: quotas before keys (referential integrity)
const providerResults = await seedProviders(data.providers ?? {});
const quotaResults = await seedQuotas(data.quotas ?? {});
const aliasResults = await seedAliases(data.aliases ?? {});
const keyResults = await seedKeys(data.keys ?? {});
const mcpServerResults = await seedMcpServers(data.mcpServers ?? {});

// Report
console.log('\n──────────────────────────────────────────');
printSection('Providers', providerResults);
printSection('Quotas', quotaResults);
printSection('Aliases', aliasResults);
printSection('Keys', keyResults);
printSection('MCP Servers', mcpServerResults);

const allResults = [
  ...providerResults,
  ...quotaResults,
  ...aliasResults,
  ...keyResults,
  ...mcpServerResults,
];
const totalOk = allResults.filter((r) => r.ok).length;
const totalErr = allResults.filter((r) => !r.ok).length;

console.log('\n──────────────────────────────────────────');
if (totalErr === 0) {
  console.log(
    `\n  ✓  Done! ${totalOk}/${allResults.length} resources created/updated successfully.\n`
  );
} else {
  console.log(`\n  ✗  Completed with errors: ${totalOk} ok, ${totalErr} failed.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Traffic — populates request_usage / inference_errors / debug_logs so the
// Dashboard, Logs, Errors, and Debug pages have data too. Skip with
// PLEXUS_SKIP_TRAFFIC=1 (e.g. in CI, or if you only want config seeded).
// ---------------------------------------------------------------------------

if (process.env.PLEXUS_SKIP_TRAFFIC === '1') {
  console.log('  ℹ  PLEXUS_SKIP_TRAFFIC=1 — skipping traffic generation.\n');
} else {
  console.log('──────────────────────────────────────────');
  console.log('\n  Generating traffic (Dashboard / Logs / Errors / Debug data)...\n');

  process.stdout.write('  Mock upstream (:4010)...');
  const upstreamState = await ensureMockUpstream();
  if (upstreamState === 'failed') {
    console.log(' ✗ failed to start — skipping traffic generation.');
    console.log(
      '     Try starting it manually: bun run scripts/mock-upstream.ts\n'
    );
  } else {
    console.log(upstreamState === 'already-running' ? ' already running' : ' started');

    process.stdout.write('  Enabling debug capture...');
    const debugOk = await enableDebugCapture();
    console.log(debugOk ? ' ok' : ' failed (continuing anyway)');

    process.stdout.write('  Firing chat completions through the gateway...');
    const traffic = await generateTraffic(data.keys ?? {}, data.aliases ?? {});
    console.log(
      ` done (${traffic.total} requests: ${traffic.ok} ok, ${traffic.failed} failed — a healthy mix for Dashboard/Logs/Errors)\n`
    );
  }
}
