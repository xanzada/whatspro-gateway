(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WhatsProChatCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char];
    });
  }

  function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function chatState(chat) {
    var state = String(chat && (chat.state || chat.status) || '').toLowerCase();
    if (chat && (chat.archived || chat.closed) || state === 'archive' || state === 'archived') return 'archive';
    if (state === 'new' || state === 'all' || state === 'operator') return state;
    if (chat && chat.unread) return 'new';
    return chat && chat.hasOperator ? 'operator' : 'all';
  }

  function chatColumn(chat) {
    if (chat && chat.sos === true && Number(chat.sosExpiresAt || 0) > Date.now()) return 'sos';
    var column = chatState(chat);
    // "Zhana" and "Baru" used to be two columns answering one question - what
    // needs the operator's eyes - and every client reply bounced the card
    // between them. One merged column now holds both; the unread badge still
    // marks what is fresh inside it (operator request, 2026-08-20).
    return column === 'new' ? 'all' : column;
  }

  function applyPendingViews(chats, phones) {
    var pending = new Set((Array.isArray(phones) ? phones : []).map(normalizePhone).filter(Boolean));
    return (Array.isArray(chats) ? chats : []).map(function (chat) {
      if (!pending.has(normalizePhone(chat && chat.phone)) || chatState(chat) !== 'new') return chat;
      return Object.assign({}, chat, { state: 'all', unread: false, viewed: true });
    });
  }

  function roleOf(item) {
    var role = String(item && item.role || '').toLowerCase();
    var source = String(item && item.source || '').toLowerCase();
    if (role === 'operator' || source === 'operator_panel') return 'operator';
    if (['assistant', 'model', 'bot', 'ai'].indexOf(role) >= 0) return 'bot';
    if (role === 'system') return 'system';
    if (item && (item.direction === 'outgoing' || item.fromMe === true)) return 'bot';
    return 'client';
  }

  function isAudio(item) {
    var mime = String(item && item.mediaType || '').trim().toLowerCase();
    var role = String(item && item.role || '').trim().toLowerCase();
    var type = String(item && item.type || '').trim().toLowerCase();
    var system = role === 'system' || ['system', 'notification', 'notification_template', 'e2e_notification', 'protocol'].indexOf(type) >= 0;
    return Boolean(item && !system && item.hasMedia === true && /^audio\//.test(mime));
  }

  function isImage(item) {
    var mime = String(item && item.mediaType || '').trim().toLowerCase();
    var type = String(item && item.type || '').trim().toLowerCase();
    return Boolean(item && item.hasMedia === true && item.id && (mime.indexOf('image/') === 0 || type === 'image'));
  }

  function isDocument(item) {
    var mime = String(item && item.mediaType || '').trim().toLowerCase();
    var type = String(item && item.type || '').trim().toLowerCase();
    return Boolean(item && item.hasMedia === true && item.id && (mime.indexOf('application/pdf') === 0 || type === 'document'));
  }

  function receiptState(item) {
    var ack = item && (item.ack != null ? item.ack : (item.ackStatus != null ? item.ackStatus : item.status));
    if (typeof ack === 'number') return ack < 0 ? 'failed' : ack >= 3 ? 'read' : ack >= 2 ? 'delivered' : 'sent';
    ack = String(ack == null ? '' : ack).toLowerCase();
    // A message WhatsApp rejected must not read as delivered-to-the-server "✓".
    if (['failed', 'error', '-1'].indexOf(ack) >= 0) return 'failed';
    if (['read', 'played', '3', '4'].indexOf(ack) >= 0) return 'read';
    return ['delivered', '2'].indexOf(ack) >= 0 ? 'delivered' : 'sent';
  }

  function messageParts(item) {
    var parts = [];
    var text = String(item && (item.text || item.body) || '')
      .replace(/\[System:[^\]]*\]/gi, '')
      .trim();
    // WhatsApp commonly repeats a PDF's filename as the message body. The
    // document card already represents that file, so rendering the filename as
    // a separate customer bubble creates a false duplicate.
    if (isDocument(item) && /^[^/\\\r\n]{1,255}\.pdf$/i.test(text)) text = '';
    if (text) parts.push({ kind: 'text', text: text });
    if (isAudio(item) && item && item.id) parts.push({ kind: 'audio', id: String(item.id) });
    if (isImage(item)) parts.push({ kind: 'image', id: String(item.id) });
    if (isDocument(item)) parts.push({ kind: 'document', id: String(item.id) });
    return parts;
  }

  function formatTime(value, lang) {
    var numeric = Number(value || 0);
    if (numeric > 0 && numeric < 1e12) numeric *= 1000;
    var date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'kk-KZ', {
        hour: '2-digit', minute: '2-digit', hour12: false
      }).format(date);
    } catch (_) {
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    }
  }

  return {
    applyPendingViews: applyPendingViews,
    chatColumn: chatColumn,
    chatState: chatState,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    isAudio: isAudio,
    isDocument: isDocument,
    isImage: isImage,
    messageParts: messageParts,
    normalizePhone: normalizePhone,
    receiptState: receiptState,
    roleOf: roleOf
  };
}));
