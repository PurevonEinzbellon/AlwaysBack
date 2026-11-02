export class Model {
  constructor(config) { this.config = config; }

  async complete(system, user, options = {}) {
    return (await this.completeWithUsage(system, user, options)).value;
  }

  async completeWithUsage(system, user, { json = false, maxTokens = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(this.config.modelUrl, {
        method: 'POST', signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.config.modelApiKey ? { Authorization: `Bearer ${this.config.modelApiKey}` } : {})
        },
        body: JSON.stringify({ model: this.config.modelName, temperature: json ? 0.2 : 0.7,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          ...(json ? { response_format: { type: 'json_object' } } : {}),
          ...(maxTokens ? { max_tokens: maxTokens } : {}) })
      });
      if (!response.ok) throw new Error(`模型 HTTP ${response.status}`);
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型未返回文本');
      let value = content.trim();
      if (json) {
        try { value = JSON.parse(content); } catch { throw new Error('模型未返回有效 JSON'); }
      }
      const usage = payload.usage && Number.isSafeInteger(payload.usage.total_tokens) && payload.usage.total_tokens >= 0
        ? { total_tokens: payload.usage.total_tokens,
          prompt_tokens: payload.usage.prompt_tokens ?? null, completion_tokens: payload.usage.completion_tokens ?? null } : null;
      return { value, usage };
    } finally { clearTimeout(timer); }
  }
}
