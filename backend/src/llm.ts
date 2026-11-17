// Austauschbare Anbindung an Sprachmodelle. Umschalten nur per Konfiguration (kein Code):
//   LLM_PROVIDER=ollama   LLM_BASE_URL=http://127.0.0.1:11434            (lokal, Standard)
//   LLM_PROVIDER=openai   LLM_BASE_URL=https://api.openai.com/v1  LLM_API_KEY=…
// "openai" deckt jede OpenAI-kompatible API ab: OpenAI, OpenRouter, Groq, Mistral, Gemini (…/v1beta/openai), vLLM, LM Studio …
import { config } from './config.js';
import { setStatus } from './status.js';

const llmName = () => `${config.llmModel} (${config.llmProvider})`;

export interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface LlmOptions { json?: boolean; maxTokens?: number; temperature?: number }

/** Mit Wiederholung bei Überlast/Ratenlimit (HTTP 429/503, z.B. kostenlose Kontingente): 2 Versuche nach 1,5 s und 4 s. */
export async function complete(messages: LlmMessage[], opt: LlmOptions = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await completeOnce(messages, opt);
      setStatus('llm', 'Sprachmodell', 'ok', llmName());
      return out;
    } catch (e: any) {
      if (attempt >= 2 || !/HTTP (429|503)/.test(e?.message ?? '')) {
        const msg = String(e?.name === 'TimeoutError' ? 'Zeitüberschreitung' : e?.message ?? e);
        setStatus('llm', 'Sprachmodell', /HTTP (429|503)/.test(msg) ? 'warn' : 'error', `${llmName()} · ${msg.slice(0, 120)}`);
        throw e;
      }
      await new Promise(r => setTimeout(r, attempt === 0 ? 1500 : 4000));
    }
  }
}

async function completeOnce(messages: LlmMessage[], opt: LlmOptions): Promise<string> {
  const signal = AbortSignal.timeout(config.llmTimeoutMs);
  if (config.llmProvider === 'openai') {
    const r = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}) },
      body: JSON.stringify({
        model: config.llmModel, messages,
        temperature: opt.temperature ?? 0,
        ...(opt.maxTokens ? { max_tokens: opt.maxTokens } : {}),
        ...(opt.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!r.ok) throw new Error(`LLM (${config.llmModel}): HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? '';
  }
  // Ollama (native API)
  const r = await fetch(`${config.llmBaseUrl}/api/chat`, {
    method: 'POST', signal,
    body: JSON.stringify({
      model: config.llmModel, messages, stream: false,
      ...(opt.json ? { format: 'json' } : {}),
      options: { temperature: opt.temperature ?? 0, ...(opt.maxTokens ? { num_predict: opt.maxTokens } : {}) },
    }),
  });
  if (!r.ok) throw new Error(`LLM (${config.llmModel}): HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { message?: { content?: string } };
  return j.message?.content ?? '';
}
