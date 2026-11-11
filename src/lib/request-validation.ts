export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export async function readJsonBody(request: Request, limit = 64 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new InputError('Expected application/json', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('Missing request body');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new InputError('Request body too large',413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)); }
  catch { throw new InputError('Malformed JSON or UTF-8'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected a JSON object');
  return body as Record<string, unknown>;
}
export function validateFields(body: Record<string,unknown>, fields: Record<string,(v:unknown)=>boolean>) {
  const keys = Object.keys(body);
  if (!keys.length || keys.some(k => !Object.hasOwn(fields,k) || !fields[k](body[k]))) throw new InputError('Invalid or unsupported configuration field');
}
export const text = (max: number, min = 0) => (v:unknown) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
export const integer = (min: number,max: number) => (v:unknown) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const oneOf = (...values: unknown[]) => (v:unknown) => values.includes(v);
export const domain = (v:unknown) => typeof v === 'string' && v.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(v);
export const logo = (v:unknown) => { try { const u = new URL(String(v)); return typeof v === 'string' && v.length <= 2048 && u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };
