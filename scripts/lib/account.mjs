import { KufarError } from './errors.mjs';
import { UUID_RE } from './transport.mjs';

const STATUSES = ['active', 'inactive', 'deactivated', 'pending_slot', 'refused'];
const bad = (message) => new KufarError('BAD_ARGS', message);
const money = (v) => (Number(v) > 0 ? Number(v) / 100 : null);
const link = (v) => (v ? String(v).replace(/^http:\/\//, 'https://') : null);

function checkPage(limit, offset) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('--limit: целое число от 1 до 100');
  if (!Number.isInteger(offset) || offset < 0) throw bad('--offset: целое число от 0');
}

// the owner's name, phone and email stay out of the result
export function normalizeMyAd(raw) {
  const days = raw.days_remain == null ? NaN : Number(raw.days_remain);
  const st = raw.statistics ?? {};
  const thumb = raw.thumbs?.[0]?.path;
  return {
    id: String(raw.ad_id),
    title: raw.subject ?? null,
    url: link(raw.link),
    status: raw.ad_status ?? null,
    price_byn: money(raw.price_byn),
    category: raw.category == null ? null : String(raw.category),
    listed_at: raw.date ?? null,
    expires_at: raw.date_expired ?? null,
    days_left: Number.isFinite(days) ? days : null,
    stats: { views: Number(st.view) || 0, phone_views: Number(st.phone) || 0, messages: Number(st.mail) || 0, favorites: Number(st.favorite) || 0 },
    phone_hidden: raw.flags?.phone_hidden === true,
    bumped: raw.flags?.bumped === true,
    image: thumb ? `https://rms.kufar.by/v1/gallery/${thumb}` : null,
  };
}

export function normalizeConversation(raw) {
  const info = raw.ad_info;
  const last = raw.last_message;
  return {
    id: raw.conversation_id,
    type: raw.type ?? null,
    // a system conversation has an ad_info with empty strings
    ad: !info || !info.subject ? null : {
      id: String(info.id), title: info.subject, url: link(info.link), price_byn: money(info.price_byn),
      status: info.status ?? null, mine: info.is_mine === true,
    },
    with: raw.participant_info?.name || null,
    unread: Number(raw.unseen) || 0,
    marked_unread: raw.marked_as_unread === true,
    messages_total: raw.total_messages_count ?? null,
    last: last ? { text: last.preview ?? null, mine: last.is_mine === true, at: last.timestamp ?? null, attachments: last.attachments_count ?? 0 } : null,
    updated_at: raw.updated_at ?? null,
    blocked: raw.is_blocked === true || raw.is_blocked_participant === true || raw.is_blocked_by_participant === true,
  };
}

// the download link of an attachment stays out of the result
export function normalizeMessage(raw) {
  return {
    id: raw.message_id,
    type: raw.type ?? null,
    mine: raw.is_mine === true,
    at: raw.created_at ?? null,
    text: raw.text ?? null,
    read: raw.read === true,
    rejected: raw.rejected === true,
    deleted: raw.deleted === true,
    attachments: (raw.attachments ?? []).map((a) => ({
      type: a.type ?? null, name: a.parameters?.file_name ?? null, size: a.parameters?.file_size ?? null, mime: a.parameters?.mime_type ?? null,
    })),
  };
}

export async function myListings(transport, { status = 'active', limit = 50, offset = 0 } = {}) {
  if (!STATUSES.includes(status)) throw bad(`--status: ${STATUSES.join(', ')}`);
  checkPage(limit, offset);
  const raw = await transport.getJson('/my-items-v2/v1/items/count');
  if (!Array.isArray(raw)) throw new KufarError('BAD_RESPONSE', 'Куфар вернул счётчики не списком');
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const c of raw) if (STATUSES.includes(c?.status)) counts[c.status] = Number(c.value) || 0;
  const items = await transport.getJson('/my-items-v2/v2/items', { status, limit, offset, stats: 1 });
  return {
    counts,
    status,
    total: Number(items?.total) || 0,
    ads: Array.isArray(items?.ads) ? items.ads.map(normalizeMyAd) : [],
  };
}

export async function inbox(transport, { limit = 30, offset = 0, unread = false } = {}) {
  checkPage(limit, offset);
  const counter = await transport.getJson('/messaging-api/v1/counter');
  const raw = await transport.getJson('/messaging-api/v4/conversations', { limit, offset });
  if (!Array.isArray(raw?.conversations)) throw new KufarError('BAD_RESPONSE', 'В ответе Куфара нет списка диалогов');
  let conversations = raw.conversations.map(normalizeConversation);
  if (unread) conversations = conversations.filter((c) => c.unread > 0 || c.marked_unread);
  return {
    unread_total: Number(counter?.unread) || 0,
    offset,
    has_more: raw.conversations.length === limit,
    count: conversations.length,
    conversations,
  };
}

export async function chat(transport, id, { limit = 50, offset = 0 } = {}) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw bad('Нужен номер диалога (id из inbox)');
  checkPage(limit, offset);
  const raw = await transport.getJson(`/messaging-api/v4/conversations/${id}/messages`, { limit, offset });
  if (!Array.isArray(raw?.messages)) throw new KufarError('BAD_RESPONSE', 'В ответе Куфара нет списка сообщений');
  // Kufar answers newest first
  const messages = [...raw.messages].reverse().map(normalizeMessage);
  return {
    conversation: raw.conversation_info ? normalizeConversation(raw.conversation_info) : null,
    offset,
    has_more: raw.messages.length === limit,
    count: messages.length,
    messages,
  };
}
