// Shared transport: run one prompt through `claude -p` (Donnie's Claude Code subscription) and
// return the JSON object it printed plus usage. Used by classify.js and classify-songs.js when RUNNER=cc.
import { spawn } from 'node:child_process';
export const stats = { costUsd: 0, calls: 0 };

export function claudeCli(model, system, user, schemaHint) {
  return new Promise((resolve, reject) => {
    const prompt = `${system}\n\nOutput ONLY a JSON object, no prose, no code fence, matching: ${schemaHint}\n\n${user}`;
    const child = spawn('claude', ['-p', '--model', model, '--output-format', 'json'],
      { env: { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      let d; try { d = JSON.parse(out); } catch { return reject(new Error(`claude -p exit ${code}: ${(out || err).slice(0, 300)}`)); }
      if (d.is_error || typeof d.result !== 'string') return reject(new Error(`claude -p error: ${JSON.stringify(d).slice(0, 300)}`));
      const text = d.result.trim();
      if (/usage limit|rate limit|out of .*credits/i.test(text) && !text.includes('{')) return reject(new Error(`limit: ${text.slice(0, 200)}`));
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return reject(new Error(`no JSON in result: ${text.slice(0, 200)}`));
      let obj; try { obj = JSON.parse(m[0]); } catch (e) { return reject(new Error(`bad JSON in result: ${e.message}`)); }
      stats.costUsd += d.total_cost_usd || 0; stats.calls++;
      const u = d.usage || {};
      resolve({ obj, usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0 } });
    });
    child.stdin.end(prompt);
  });
}
