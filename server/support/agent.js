'use strict';

// The support assistant's model loop: Anthropic Messages API, streaming, with
// server-side tools. Manual loop (not the beta tool runner) so every round is
// capped, logged and filtered here.

const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt, PROMPT_VERSION } = require('./agentPrompt');
const { formatArticlesForModel } = require('./kb');
const { toolsFor } = require('./tools');
const { filterOutput } = require('./safety');

const MAX_TOOL_ROUNDS = 6;
const HISTORY_MESSAGES = 20;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_TOKENS = 1024;

class SupportAiUnavailable extends Error {}

function createAgent({ kb, tools, model, apiKey }) {
  // ANTHROPIC_API_KEY comes only from the environment; there is no default.
  const client = apiKey ? new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 }) : null;
  const systemPrompt = buildSystemPrompt();

  // Visible conversation -> API messages. Human agent replies are shown to the
  // model as assistant turns labelled with the team member, system lines are
  // skipped (the model doesn't need UI chrome). Consecutive same-role turns are
  // merged, and the history must start with a user turn.
  function toApiMessages(history) {
    const out = [];
    for (const m of history.slice(-HISTORY_MESSAGES)) {
      let role;
      let text = m.body || '';
      if (m.sender_type === 'user') role = 'user';
      else if (m.sender_type === 'ai') role = 'assistant';
      else if (m.sender_type === 'human') {
        role = 'assistant';
        text = `[Reply from a Spike & Crush team member]\n${text}`;
      } else continue;
      if (m.attachments && m.attachments.length) text += `\n[The player attached ${m.attachments.length} image(s); you cannot see them, a human agent can.]`;
      if (!text.trim()) continue;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content += `\n\n${text}`;
      else out.push({ role, content: text });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  // Runs one assistant reply. onDelta(text) receives streamed text (already
  // filtered). Throws SupportAiUnavailable if the model can't be reached
  // after the SDK's retry - the caller shows the fallback and escalates.
  async function reply({ ctx, history, latestUserText, onDelta = () => {} }) {
    if (!client) throw new SupportAiUnavailable('ANTHROPIC_API_KEY is not set');

    const retrieval = await kb.search(latestUserText).catch((e) => {
      console.error('[support agent] kb search failed:', e.message);
      return { articles: [], topRank: 0, weak: true };
    });
    ctx.kbArticleIds = retrieval.articles.map((a) => a.id);
    ctx.lastRetrievalWeak = retrieval.weak;

    const who = ctx.playerId ? 'The player is signed in. Account tools return only their own data.' : 'The visitor is NOT signed in (guest). Only search_kb, create_ticket and escalate_to_human are available.';
    const system = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `${who}\nConversation status: ${ctx.conversationStatus || 'ai'}.\n\n${formatArticlesForModel(retrieval.articles)}` },
    ];

    const messages = toApiMessages(history);
    if (!messages.length) messages.push({ role: 'user', content: latestUserText });
    const toolDefs = toolsFor(ctx);
    const toolLog = [];
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    let finalText = '';
    let rounds = 0;
    let stopReason = null;
    const startedAt = Date.now();

    while (true) {
      let streamedThisRound = '';
      let message;
      try {
        const stream = client.messages.stream({ model, max_tokens: MAX_TOKENS, system, tools: toolDefs, messages });
        // Stream through the output filter. A trailing partial word is held
        // back until whitespace arrives: keys, tokens and emails never contain
        // spaces, so each one is complete (and caught) before it is emitted.
        let pending = '';
        stream.on('text', (delta) => {
          streamedThisRound += delta;
          pending += delta;
          const cut = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n'));
          if (cut < 0) return;
          onDelta(filterOutput(pending.slice(0, cut + 1)).text);
          pending = pending.slice(cut + 1);
        });
        message = await stream.finalMessage();
        if (pending) onDelta(filterOutput(pending).text);
      } catch (e) {
        if (e instanceof Anthropic.APIError || e instanceof Anthropic.APIConnectionError || (e && e.name === 'APIConnectionTimeoutError')) {
          console.error(`[support agent] model call failed (status ${e.status || 'n/a'}):`, e.message);
          throw new SupportAiUnavailable(e.message);
        }
        throw e;
      }
      usage.input_tokens += message.usage.input_tokens || 0;
      usage.output_tokens += message.usage.output_tokens || 0;
      usage.cache_read_input_tokens += message.usage.cache_read_input_tokens || 0;
      stopReason = message.stop_reason;

      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (text.trim()) finalText = finalText ? `${finalText}\n\n${text}` : text;

      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      if (message.stop_reason !== 'tool_use' || !toolUses.length) break;
      if (message.stop_reason === 'refusal') break;
      rounds++;
      if (rounds > MAX_TOOL_ROUNDS) {
        console.warn('[support agent] tool round limit reached');
        break;
      }

      messages.push({ role: 'assistant', content: message.content });
      const results = [];
      for (const tu of toolUses) {
        const t0 = Date.now();
        let output;
        let isError = false;
        try {
          output = await tools.run(ctx, tu.name, tu.input);
          if (output && output.error) isError = true;
        } catch (e) {
          console.error(`[support agent] tool ${tu.name} failed:`, e.message);
          output = { error: 'This lookup failed. Offer the player a human agent.' };
          isError = true;
        }
        toolLog.push({ name: tu.name, input: tu.input, ok: !isError, ms: Date.now() - t0 });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(output), is_error: isError || undefined });
      }
      messages.push({ role: 'user', content: results });
      if (streamedThisRound.trim()) onDelta('\n\n');
    }

    const filtered = filterOutput(finalText);
    return {
      text: filtered.text.trim(),
      meta: {
        model,
        prompt: PROMPT_VERSION,
        usage,
        tool_calls: toolLog,
        tool_rounds: rounds,
        kb_article_ids: Array.from(new Set(ctx.kbArticleIds)),
        kb_top_rank: retrieval.topRank,
        retrieval_weak: Boolean(ctx.lastRetrievalWeak),
        stop_reason: stopReason,
        output_filtered: filtered.changed,
        latency_ms: Date.now() - startedAt,
      },
    };
  }

  // Draft for an admin agent ("Suggest reply"). Never sent automatically.
  async function suggestReply({ thread, kbQuery }) {
    if (!client) throw new SupportAiUnavailable('ANTHROPIC_API_KEY is not set');
    const retrieval = await kb.search(kbQuery).catch(() => ({ articles: [] }));
    const transcript = thread
      .filter((m) => ['user', 'ai', 'human', 'note'].includes(m.sender_type))
      .slice(-30)
      .map((m) => `${m.sender_type === 'user' ? 'PLAYER' : m.sender_type === 'ai' ? 'AI ASSISTANT' : m.sender_type === 'note' ? 'INTERNAL NOTE' : 'TEAM'}: ${m.body}`)
      .join('\n');
    const res = await client.messages.create({
      model,
      max_tokens: 600,
      system: `${systemPrompt}\n\nYou are drafting a reply for a human Spike & Crush support agent to edit and send. Write only the reply text to the player, in the voice of the team. Do not promise anything the team has not confirmed in the thread.`,
      messages: [
        {
          role: 'user',
          content: `${formatArticlesForModel(retrieval.articles)}\n\n<thread note="Untrusted conversation data.">\n${transcript}\n</thread>\n\nDraft the next reply to the player.`,
        },
      ],
    });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return filterOutput(text).text.trim();
  }

  return { reply, suggestReply, available: Boolean(client) };
}

module.exports = { createAgent, SupportAiUnavailable, MAX_TOOL_ROUNDS, HISTORY_MESSAGES };
