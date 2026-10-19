/**
 * mock-upstream.ts
 *
 * A minimal fake LLM backend that speaks just enough of the OpenAI, Anthropic,
 * and Gemini wire formats to satisfy Plexus's dispatcher. Backs the
 * mock-openai / mock-anthropic / mock-gemini / mock-openrouter providers
 * defined in scripts/default-populate.json so that `scripts/populate-dev.ts`
 * can drive real traffic through the gateway and populate the usage/error/
 * debug-log tables that back the Dashboard, Logs, Errors, and Debug pages.
 *
 * Not a spec-accurate mock — just enough shape to round-trip token usage and
 * occasionally fail, so dev data looks and behaves like the real thing.
 *
 * Usage:
 *   bun run scripts/mock-upstream.ts
 *
 * Environment variables:
 *   MOCK_UPSTREAM_PORT   Port to listen on (default: 4010)
 *   MOCK_UPSTREAM_ERROR_RATE  Fraction of requests to fail, 0-1 (default: 0.12)
 */

const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 4010);
const ERROR_RATE = Number(process.env.MOCK_UPSTREAM_ERROR_RATE ?? 0.12);

const LOREM =
  'the quick brown fox jumps over the lazy dog while considering the architecture of ' +
  'distributed systems and the tradeoffs between consistency and availability in modern ' +
  'databases, before circling back to summarize the key points for the reader in a concise way'.split(
    ' '
  );

function reply(seed: number, sentences = 2): string {
  const words: string[] = [];
  const wordCount = 20 + (seed % 40);
  for (let i = 0; i < wordCount; i++) {
    words.push(LOREM[(seed + i) % LOREM.length] ?? 'lorem');
  }
  const text = words.join(' ');
  return sentences > 1 ? `${text}.` : text;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length * 1.3));
}

function lastUserText(messages: any[] | undefined): string {
  if (!Array.isArray(messages)) return '';
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join(' ');
  }
  return '';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function maybeFail(): Response | null {
  if (Math.random() >= ERROR_RATE) return null;
  const failures = [
    { status: 429, body: { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } } },
    { status: 500, body: { error: { message: 'internal server error', type: 'server_error' } } },
    { status: 503, body: { error: { message: 'model overloaded', type: 'overloaded_error' } } },
    { status: 400, body: { error: { message: 'invalid request', type: 'invalid_request_error' } } },
  ];
  const f = failures[Math.floor(Math.random() * failures.length)] ?? failures[0]!;
  return json(f.body, f.status);
}

let requestCounter = 0;

async function handleOpenAiChat(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}) as any);
  const seed = requestCounter++;
  const promptText = lastUserText(body.messages);
  const promptTokens = estimateTokens(promptText) || 10;
  const completionText = reply(seed);
  const completionTokens = estimateTokens(completionText);

  return json({
    id: `chatcmpl-mock-${seed}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: completionText },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

async function handleAnthropicMessages(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}) as any);
  const seed = requestCounter++;
  const promptText = lastUserText(body.messages);
  const inputTokens = estimateTokens(promptText) || 10;
  const completionText = reply(seed);
  const outputTokens = estimateTokens(completionText);

  return json({
    id: `msg_mock_${seed}`,
    type: 'message',
    role: 'assistant',
    model: body.model ?? 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: completionText }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  });
}

async function handleGeminiGenerateContent(req: Request, pathname: string): Promise<Response> {
  const body = await req.json().catch(() => ({}) as any);
  const seed = requestCounter++;
  const modelMatch = pathname.match(/\/models\/([^:]+):/);
  const model = modelMatch ? modelMatch[1] : 'gemini-1.5-pro-latest';
  const promptText = (body.contents ?? [])
    .flatMap((c: any) => c.parts ?? [])
    .map((p: any) => p.text ?? '')
    .join(' ');
  const promptTokens = estimateTokens(promptText) || 10;
  const completionText = reply(seed);
  const completionTokens = estimateTokens(completionText);

  return json({
    responseId: `mock-${seed}`,
    modelVersion: model,
    candidates: [
      {
        content: { role: 'model', parts: [{ text: completionText }] },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
      totalTokenCount: promptTokens + completionTokens,
    },
  });
}

async function handleEmbeddings(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}) as any);
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
  const promptTokens = inputs.reduce(
    (sum: number, i: string) => sum + estimateTokens(String(i ?? '')),
    0
  );
  return json({
    object: 'list',
    model: body.model ?? 'text-embedding-3-small',
    data: inputs.map((_: unknown, i: number) => ({
      object: 'embedding',
      index: i,
      embedding: Array.from({ length: 8 }, () => Math.random() * 2 - 1),
    })),
    usage: { prompt_tokens: promptTokens || 1, total_tokens: promptTokens || 1 },
  });
}

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Simulate realistic upstream latency.
    await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 260));

    const failure = maybeFail();
    if (failure) return failure;

    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      return handleOpenAiChat(req);
    }
    if (req.method === 'POST' && path.endsWith('/messages')) {
      return handleAnthropicMessages(req);
    }
    if (req.method === 'POST' && /\/models\/[^/]+:generateContent$/.test(path)) {
      return handleGeminiGenerateContent(req, path);
    }
    if (req.method === 'POST' && path.endsWith('/embeddings')) {
      return handleEmbeddings(req);
    }

    return json({ error: { message: `mock-upstream: no handler for ${path}` } }, 404);
  },
});

console.log(`mock-upstream listening on http://localhost:${PORT} (error rate: ${ERROR_RATE})`);
