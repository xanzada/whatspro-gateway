(function () {
  'use strict';

  var core = window.WhatsProChatCore;
  if (!core) throw new Error('WhatsProChatCore is required');

  var params = new URLSearchParams(window.location.search);
  var config = window.__CHAT_CONFIG__ || {};
  var instanceId = String(params.get('instance') || config.instance || '').trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(instanceId)) throw new Error('BAD_INSTANCE_ID');
  var branding = config.branding || {};

  function safeApiBase(value) {
    try {
      var raw = String(value || '').replace(/\/+$/, '');
      return raw && new URL(raw, location.href).origin === location.origin ? raw : '';
    } catch (_) { return ''; }
  }

  var apiBase = safeApiBase(config.apiBase);
  var chatToken = String(config.chatToken || '');
  var endpoints = Object.assign({
    inbox: '/api/chat/inbox', history: '/api/chat/history', send: '/api/chat/send',
    media: '/api/chat/media', lock: '/api/chat/operator-lock', action: '/api/chat/action',
    events: '/api/chat/events'
  }, config.endpoints || {});

  var dictionary = {
    kk: {
      title: 'Оператор чаты', operator: 'Оператор', search: 'Аты, телефоны немесе хабар бойынша іздеу',
      tabs: { sos: 'SOS', all: 'Бәрі', operator: 'Опер', archive: 'Архив' },
      select: 'Чатты таңдаңыз', selectHint: 'Толық хат алмасу тарихы осы жерде шығады.',
      noChats: 'Бұл бөлімде чаттар жоқ', noResults: 'Ештеңе табылмады', noMessages: 'Хабарламалар жоқ',
      loading: 'Жүктелуде…', loadFailed: 'Жүктеу мүмкін болмады', reply: 'Жауап жазу…', archived: 'Чат архивте',
      send: 'Жіберу', back: 'Артқа', refresh: 'Жаңарту', refreshed: 'Жаңартылды', sendFailed: 'Хабар жіберілмеді',
      client: 'Клиент', bot: 'Бот', operatorRole: 'Оператор', system: 'Жүйе', unknown: 'Сақталмаған контакт',
      sosBadge: 'SOS', newBadge: 'Жаңа', archiveBadge: 'Архив', operatorBadge: 'Опер', botMuted: 'Бот өшірулі',
      archive: 'Архивке жіберу', restore: 'Архивтен қайтару', remove: 'Біржола өшіру',
      confirmYes: 'Иә', confirmNo: 'Болдырмау', mediaFailed: 'Файлды ашу мүмкін болмады', viewerDownload: 'Жүктеп алу', viewerOpen: 'Жаңа терезеде ашу', viewerNote: 'Телефон браузері PDF-ті бет ішінде көрсетпейді. «Жүктеп алу» немесе «Жаңа терезеде ашу» түймесін басыңыз.', actionFailed: 'Әрекет орындалмады. Қайта көріңіз', viewerClose: 'Жабу',
      confirmArchive: 'Бұл чатты архивке жіберу керек пе?', confirmRestore: 'Бұл чатты архивтен қайтару керек пе?',
      confirmDelete: 'Чатты және барлық хабарламаны біржола өшіру керек пе? Бұл әрекетті қайтару мүмкін емес.',
      archiveDone: 'Чат архивке жіберілді', restoreDone: 'Чат қайтарылды', deleteDone: 'Чат өшірілді',
      audioFailed: 'Аудио жүктелмеді', imageFailed: 'Фото жүктелмеді', photo: 'Фото', document: 'PDF құжат', play: 'Ойнату', pause: 'Кідірту', direct: function (phone) { return '+' + phone + ' нөміріне жазу'; }
    },
    ru: {
      title: 'Чат оператора', operator: 'Оператор', search: 'Поиск по имени, телефону или сообщению',
      tabs: { sos: 'SOS', all: 'Все', operator: 'Опер', archive: 'Архив' },
      select: 'Выберите чат', selectHint: 'Здесь появится полная история сообщений.',
      noChats: 'В этом разделе нет чатов', noResults: 'Ничего не найдено', noMessages: 'Нет сообщений',
      loading: 'Загрузка…', loadFailed: 'Не удалось загрузить', reply: 'Написать ответ…', archived: 'Чат в архиве',
      send: 'Отправить', back: 'Назад', refresh: 'Обновить', refreshed: 'Обновлено', sendFailed: 'Сообщение не отправлено',
      client: 'Клиент', bot: 'Бот', operatorRole: 'Оператор', system: 'Система', unknown: 'Несохранённый контакт',
      sosBadge: 'SOS', newBadge: 'Новое', archiveBadge: 'Архив', operatorBadge: 'Опер', botMuted: 'Бот отключён',
      archive: 'Отправить в архив', restore: 'Вернуть из архива', remove: 'Удалить навсегда',
      confirmYes: 'Да', confirmNo: 'Отмена', mediaFailed: 'Не удалось открыть файл', viewerDownload: 'Скачать', viewerOpen: 'Открыть в новой вкладке', viewerNote: 'Браузер телефона не показывает PDF внутри страницы. Нажмите «Скачать» или «Открыть в новой вкладке».', actionFailed: 'Действие не выполнено. Попробуйте снова', viewerClose: 'Закрыть',
      confirmArchive: 'Отправить этот чат в архив?', confirmRestore: 'Вернуть этот чат из архива?',
      confirmDelete: 'Навсегда удалить чат и все сообщения? Это действие нельзя отменить.',
      archiveDone: 'Чат отправлен в архив', restoreDone: 'Чат восстановлен', deleteDone: 'Чат удалён',
      audioFailed: 'Не удалось загрузить аудио', imageFailed: 'Не удалось загрузить фото', photo: 'Фото', document: 'PDF документ', play: 'Воспроизвести', pause: 'Пауза', direct: function (phone) { return 'Написать +' + phone; }
    }
  };

  var el = {};
  var eventsBound = false;
  ['app', 'instance-title', 'lang-btn', 'refresh-btn', 'search-input', 'tabs', 'direct-chat', 'contact-list',
    'back-btn', 'active-name', 'active-meta', 'operator-lock', 'lock-seconds', 'archive-btn', 'delete-btn',
    'messages-viewport', 'messages', 'message-input', 'send-btn', 'toast'].forEach(function (id) {
    el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id);
  });

  var state = {
    lang: localStorage.getItem('operator_chat_lang') === 'ru' ? 'ru' : 'kk',
    chats: [], activeTab: 'all', activePhone: '', history: [],
    inboxBusy: false, historyBusy: false, inboxDirty: false, historyDirty: false, actionBusy: false, sending: false,
    inboxSignature: '', historySignature: '', lockUntil: 0,
    pollTimer: 0, lockTimer: 0, reconnectTimer: 0, eventAbort: null, eventFailures: 0,
    eventRefreshTimer: 0, toastTimer: 0, mediaAbort: null, audioUrls: new Map(), retrySend: null,
    pendingViews: Object.create(null)
  };

  function t(key) { return dictionary[state.lang][key] == null ? key : dictionary[state.lang][key]; }
  function headers(extra) {
    return Object.assign({}, chatToken ? { 'x-chat-token': chatToken, 'x-chat-instance': instanceId } : {}, extra || {});
  }

  // The chat token lives 24h; a panel left open longer used to strand every
  // control at once - archive/delete buttons, refreshes, PDF links all failed
  // with a bare 401. One reload mints a fresh token (the page render issues
  // it); the sessionStorage guard keeps a genuinely broken session from
  // cycling forever (operator report, 2026-08-20).
  function handleAuthFailure() {
    var last = 0;
    try { last = Number(sessionStorage.getItem('chatAuthReloadAt') || 0); } catch (_) {}
    if (Date.now() - last < 60000) return;
    try { sessionStorage.setItem('chatAuthReloadAt', String(Date.now())); } catch (_) {}
    location.reload();
  }
  // Chrome offers "prevent this page from creating additional dialogs" after a
  // few prompts, and an embedded panel can be framed without allow-modals. In
  // both cases window.confirm() returns false forever, so archive and delete
  // looked completely dead with no error anywhere (operator report 2026-08-21).
  // An in-page dialog cannot be suppressed by the browser.
  function confirmDialog(message) {
    var backdrop = document.getElementById('confirm-backdrop');
    var text = document.getElementById('confirm-text');
    var okBtn = document.getElementById('confirm-ok');
    var cancelBtn = document.getElementById('confirm-cancel');
    if (!backdrop || !text || !okBtn || !cancelBtn) return Promise.resolve(true);
    text.textContent = message;
    okBtn.textContent = t('confirmYes');
    cancelBtn.textContent = t('confirmNo');
    backdrop.classList.add('show');
    return new Promise(function (resolve) {
      function finish(result) {
        backdrop.classList.remove('show');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onOk() { finish(true); }
      function onCancel() { finish(false); }
      function onBackdrop(event) { if (event.target === backdrop) finish(false); }
      function onKey(event) {
        if (event.key === 'Escape') finish(false);
        else if (event.key === 'Enter') finish(true);
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
      try { okBtn.focus(); } catch (_) {}
    });
  }

  // The page render is the only place that used to mint a chat token, so a tab
  // open past the 24h TTL could only recover through a full reload - and the
  // reload guard below swallowed the click entirely. Re-minting in place keeps
  // the operator's action alive.
  var tokenRefresh = null;
  function refreshChatToken() {
    if (tokenRefresh) return tokenRefresh;
    tokenRefresh = (async function () {
      try {
        var url = apiBase + (endpoints.session || '/api/chat/session') + '/' + encodeURIComponent(instanceId);
        var response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) return false;
        var data = await response.json().catch(function () { return {}; });
        var next = String(data.chatToken || '');
        if (!next) return false;
        chatToken = next;
        try { localStorage.setItem('token_key', next); } catch (_) {}
        return true;
      } catch (_) {
        return false;
      } finally {
        tokenRefresh = null;
      }
    })();
    return tokenRefresh;
  }

  function isAuthStatus(status, data) {
    if (status === 401 || status === 403) return true;
    return status === 400 && /AUTH|TOKEN|INSTANCE/i.test(String(data && data.error || ''));
  }

  async function fetchMediaBlob(id) {
    var response = await fetch(mediaUrl(id), { credentials: 'same-origin', cache: 'no-store', headers: headers({}) });
    if (isAuthStatus(response.status, null) && await refreshChatToken()) {
      response = await fetch(mediaUrl(id), { credentials: 'same-origin', cache: 'no-store', headers: headers({}) });
    }
    if (!response.ok) throw new Error('HTTP_' + response.status);
    return response.blob();
  }

  // A token in the query string expires and a new tab can be popup-blocked, so
  // the PDF link failed twice over. Fetching the bytes with the live token and
  // handing the browser a blob removes both failure modes.
  // window.open cannot be trusted here. The bytes are fetched first, so by the
  // time it runs the click is no longer a user gesture, and Safari, Android
  // WebView and in-app browsers answer with a truthy window that never paints
  // anything - the viewer was then skipped and nothing opened at all. The
  // in-page viewer is the only automatic path now; a new tab is a button the
  // operator presses themselves, which keeps the gesture intact.
  async function openMedia(id, isDocument) {
    var blob = await fetchMediaBlob(id);
    showMediaViewer(URL.createObjectURL(blob), isDocument);
  }

  function isMobileViewer() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(String(navigator.userAgent || '')) || window.innerWidth < 768;
  }

  function showMediaViewer(objectUrl, isDocument) {
    var viewer = document.getElementById('media-viewer');
    var frame = document.getElementById('media-frame');
    var image = document.getElementById('media-image');
    var note = document.getElementById('media-note');
    var download = document.getElementById('media-download');
    var openBtn = document.getElementById('media-open');
    var closeBtn = document.getElementById('media-close');
    if (!viewer || !frame) { window.location.href = objectUrl; return; }
    // Android Chrome and in-app browsers refuse to paint a PDF inside a frame,
    // so on phones the download and open buttons are the working affordances.
    var inlinePdf = isDocument && !isMobileViewer();
    if (image) {
      image.hidden = isDocument;
      if (isDocument) image.removeAttribute('src');
      else image.src = objectUrl;
    }
    frame.hidden = !inlinePdf;
    if (inlinePdf) frame.src = objectUrl;
    else frame.removeAttribute('src');
    if (note) {
      note.hidden = !isDocument || inlinePdf;
      note.textContent = note.hidden ? '' : t('viewerNote');
    }
    if (download) {
      download.href = objectUrl;
      download.setAttribute('download', isDocument ? 'document.pdf' : 'image.jpg');
      download.textContent = t('viewerDownload');
    }
    if (openBtn) {
      openBtn.textContent = t('viewerOpen');
      openBtn.onclick = function () { try { window.open(objectUrl, '_blank'); } catch (_) {} };
    }
    if (closeBtn) closeBtn.textContent = t('viewerClose');
    viewer.classList.add('show');
    function hide() {
      viewer.classList.remove('show');
      frame.removeAttribute('src');
      if (image) image.removeAttribute('src');
      if (note) { note.hidden = true; note.textContent = ''; }
      if (closeBtn) closeBtn.removeEventListener('click', hide);
      document.removeEventListener('keydown', onViewerKey);
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
    }
    function onViewerKey(event) { if (event.key === 'Escape') hide(); }
    document.addEventListener('keydown', onViewerKey);
    if (closeBtn) closeBtn.addEventListener('click', hide);
  }

  async function handleMediaOpenClick(event) {
    var link = event.target.closest ? event.target.closest('[data-media-id]') : null;
    if (!link) return;
    event.preventDefault();
    var id = link.getAttribute('data-media-id');
    if (!id || state.mediaBusy) return;
    state.mediaBusy = true;
    try {
      await openMedia(id, link.classList.contains('chat-document'));
    } catch (_) {
      showToast(t('mediaFailed'), true);
    } finally {
      state.mediaBusy = false;
    }
  }

  function endpoint(name, suffix) { return apiBase + endpoints[name] + (suffix || ''); }

  async function requestJson(url, options, retried) {
    var response = await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}, {
      headers: headers(Object.assign({ Accept: 'application/json' }, options && options.headers || {}))
    }));
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      // A stale token stranded every control at once. Mint a fresh one and
      // replay the request before the operator ever sees an error.
      if (!retried && isAuthStatus(response.status, data) && await refreshChatToken()) {
        return requestJson(url, options, true);
      }
      var requestError = new Error(data.error || 'HTTP_' + response.status);
      requestError.status = response.status;
      throw requestError;
    }
    return data;
  }

  function getJson(url) { return requestJson(url); }
  function postJson(url, body) {
    return requestJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  function showToast(message, error) {
    clearTimeout(state.toastTimer);
    el.toast.innerHTML = '<i class="fa-solid fa-' + (error ? 'circle-exclamation' : 'circle-check') + '"></i><span>' + core.escapeHtml(message) + '</span>';
    el.toast.classList.add('show');
    state.toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2400);
  }

  function currentChat() {
    return state.chats.find(function (chat) { return core.normalizePhone(chat.phone) === state.activePhone; }) || null;
  }

  function contactName(chat) {
    return String(chat && (chat.contactName || chat.name || chat.displayName || chat.pushName) || '').trim();
  }

  function chatMatchesTab(chat) { return core.chatColumn(chat) === state.activeTab; }

  function filteredChats() {
    var query = el.searchInput.value.trim().toLowerCase();
    var phoneQuery = query.replace(/\D/g, '');
    if (phoneQuery.charAt(0) === '8' && phoneQuery.length > 1) phoneQuery = '7' + phoneQuery.slice(1);
    return state.chats.filter(function (chat) {
      if (!chatMatchesTab(chat)) return false;
      if (!query) return true;
      var phone = String(chat.phone || '').replace(/\D/g, '');
      if (phoneQuery && phone.indexOf(phoneQuery) >= 0) return true;
      return [contactName(chat), chat.lastText, chat.lastMessage].some(function (value) {
        return String(value || '').toLowerCase().indexOf(query) >= 0;
      });
    });
  }

  function renderTabs() {
    var counts = { sos: 0, new: 0, all: 0, operator: 0, archive: 0 };
    var sosUnread = 0;
    state.chats.forEach(function (chat) { var key = core.chatColumn(chat); if (counts[key] != null) counts[key] += 1; if (key === 'sos' && chat.sosUnread) sosUnread += 1; });
    el.tabs.innerHTML = ['sos', 'all', 'operator', 'archive'].map(function (key) {
      return '<button class="tab' + (key === 'sos' && sosUnread ? ' has-sos-alert' : '') + '" type="button" role="tab" aria-selected="' + (state.activeTab === key) + '" data-tab="' + key + '">' +
        core.escapeHtml(t('tabs')[key]) + (counts[key] ? ' · ' + counts[key] : '') + '</button>';
    }).join('');
  }

  function renderContacts() {
    renderTabs();
    var query = el.searchInput.value.trim();
    var phoneCandidate = core.normalizePhone(query);
    var known = state.chats.some(function (chat) { return core.normalizePhone(chat.phone) === phoneCandidate; });
    el.directChat.hidden = !query || phoneCandidate.length < 10 || known;
    if (!el.directChat.hidden) el.directChat.textContent = t('direct')(phoneCandidate);

    var chats = filteredChats();
    if (!chats.length) {
      el.contactList.innerHTML = '<div class="empty"><div><i class="fa-solid fa-inbox fa-2x"></i><p>' + core.escapeHtml(query ? t('noResults') : t('noChats')) + '</p></div></div>';
      return;
    }
    el.contactList.innerHTML = chats.map(function (chat) {
      var phone = core.normalizePhone(chat.phone);
      var tabState = core.chatState(chat);
      var column = core.chatColumn(chat);
      var name = contactName(chat) || t('unknown');
      var badge = column === 'sos' ? t('sosBadge') : tabState === 'new' ? t('newBadge') : tabState === 'operator' ? t('operatorBadge') : tabState === 'archive' ? t('archiveBadge') : '';
      var sosPulse = column === 'sos' && chat.sosUnread ? '<span class="sos-pulse" aria-label="SOS"></span>' : '';
      return '<button type="button" class="contact-item ' + tabState + (column === 'sos' ? ' sos' : '') + (phone === state.activePhone ? ' active' : '') + '" data-phone="' + core.escapeHtml(phone) + '">' +
        '<span class="contact-avatar"><i class="fa-solid fa-user"></i>' + sosPulse + '</span><span class="contact-copy">' +
        '<span class="contact-name truncate">' + core.escapeHtml(name) + '</span><span class="contact-phone truncate">+' + core.escapeHtml(phone) + '</span>' +
        '<span class="contact-snippet truncate">' + core.escapeHtml(chat.lastText || chat.lastMessage || t('noMessages')) + '</span></span>' +
        '<span class="contact-meta"><span class="contact-time">' + core.escapeHtml(core.formatTime(chat.lastAt || chat.updatedAt, state.lang)) + '</span>' +
        (badge ? '<span class="badge ' + (column === 'sos' ? 'sos-badge' : '') + '">' + core.escapeHtml(badge) + '</span>' : '') + '</span></button>';
    }).join('');
  }

  function emptyChat() {
    el.messages.innerHTML = '<div class="empty"><div><i class="fa-regular fa-comments fa-3x"></i><h2>' + core.escapeHtml(t('select')) + '</h2><p>' + core.escapeHtml(t('selectHint')) + '</p></div></div>';
  }

  function renderStaticText() {
    document.documentElement.lang = state.lang === 'ru' ? 'ru' : 'kk';
    document.title = t('title');
    document.querySelectorAll('[data-i18n]').forEach(function (node) { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll('[data-i18n-title]').forEach(function (node) { var value = t(node.dataset.i18nTitle); node.title = value; node.setAttribute('aria-label', value); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) { node.placeholder = t(node.dataset.i18nPlaceholder); });
    el.instanceTitle.textContent = String(branding.name || instanceId || 'WhatsPro');
    el.langBtn.textContent = state.lang === 'ru' ? 'KZ' : 'RU';
  }

  function renderHeader() {
    var chat = currentChat();
    if (!state.activePhone) {
      el.activeName.textContent = t('select'); el.activeMeta.textContent = t('selectHint');
      el.archiveBtn.hidden = true; el.deleteBtn.hidden = true;
    } else {
      el.activeName.textContent = contactName(chat) || '+' + state.activePhone;
      el.activeMeta.textContent = contactName(chat) ? '+' + state.activePhone : (core.chatState(chat) === 'archive' ? t('archived') : 'WhatsApp');
      el.archiveBtn.hidden = false; el.deleteBtn.hidden = false;
      var archived = core.chatState(chat) === 'archive';
      el.archiveBtn.title = archived ? t('restore') : t('archive');
      el.archiveBtn.setAttribute('aria-label', el.archiveBtn.title);
      el.archiveBtn.innerHTML = '<i class="fa-solid fa-' + (archived ? 'arrow-rotate-left' : 'box-archive') + '"></i>';
      el.deleteBtn.title = t('remove'); el.deleteBtn.setAttribute('aria-label', t('remove'));
    }
    updateComposer(); renderLock();
  }

  function updateComposer() {
    var disabled = !state.activePhone || state.sending || state.actionBusy;
    el.messageInput.disabled = disabled;
    el.messageInput.placeholder = t('reply');
    el.sendBtn.disabled = disabled || !el.messageInput.value.trim();
  }

  function renderReceipt(item, role) {
    if (role !== 'bot' && role !== 'operator') return '';
    var receipt = core.receiptState({ ack: item.ack, ackStatus: item.ackStatus, status: item.deliveryStatus || item.status });
    var mark = receipt === 'failed' ? '✕' : receipt === 'sent' ? '✓' : '✓✓';
    return '<span class="ticks ' + receipt + '" aria-label="' + receipt + '">' + mark + '</span>';
  }

  function mediaUrl(id) {
    var query = new URLSearchParams();
    var mediaToken = chatToken;
    if (!mediaToken) { try { mediaToken = String(localStorage.getItem('token_key') || ''); } catch (_) {} }
    if (mediaToken) query.set('token', mediaToken);
    if (state.activePhone) query.set('phone', state.activePhone);
    var url = endpoint('media', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(id));
    return query.toString() ? url + '?' + query.toString() : url;
  }

  function messageBubble(item, part) {
    var role = core.roleOf(item);
    var label = role === 'client' ? t('client') : role === 'bot' ? t('bot') : role === 'operator' ? t('operatorRole') : t('system');
    var timestamp = core.formatTime(item.createdAt || item.timestamp || item.sentAt, state.lang);
    var content = '';
    if (part.kind === 'text') content = '<div class="message-text">' + core.escapeHtml(part.text) + '</div>';
    if (part.kind === 'audio') {
      content = '<div class="audio-player" data-audio-id="' + core.escapeHtml(part.id) + '" aria-busy="true"><audio preload="none" playsinline></audio>' +
        '<button class="audio-play" type="button" aria-label="' + core.escapeHtml(t('play')) + '"><i class="fa-solid fa-play"></i></button>' +
        '<input class="audio-seek" type="range" min="0" max="1000" value="0" aria-label="Seek"><span class="audio-duration">0:00</span>' +
        '<button class="audio-speed" type="button">1x</button></div>';
    }
    if (part.kind === 'image') {
      var imageUrl = mediaUrl(part.id);
      content = '<a class="chat-image-link" data-media-id="' + core.escapeHtml(part.id) + '" href="' + core.escapeHtml(imageUrl) + '" target="_blank" rel="noopener"><img class="chat-image" src="' + core.escapeHtml(imageUrl) + '" alt="' + core.escapeHtml(t('photo')) + '" loading="lazy"><span class="image-error"><i class="fa-solid fa-image"></i> ' + core.escapeHtml(t('imageFailed')) + '</span></a>';
    }
    if (part.kind === 'document') {
      // The href stays as a plain fallback for middle-click and \"copy link\",
      // but the click is handled by openMedia so no popup or query token is
      // needed to read the document.
      content = '<a class="chat-document" data-media-id="' + core.escapeHtml(part.id) + '" href="' + core.escapeHtml(mediaUrl(part.id)) + '" target="_blank" rel="noopener">' +
        '<i class="fa-solid fa-file-pdf"></i><span>' + core.escapeHtml(t('document')) + '</span></a>';
    }
    return '<div class="message-row ' + role + '"><div class="bubble ' + (part.kind === 'audio' ? 'audio-bubble' : part.kind === 'image' ? 'image-bubble' : part.kind === 'document' ? 'document-bubble' : '') + '">' +
      (role === 'system' ? '' : '<div class="role">' + core.escapeHtml(label) + '</div>') + content +
      '<div class="bubble-foot"><time>' + core.escapeHtml(timestamp) + '</time>' + renderReceipt(item, role) + '</div></div></div>';
  }

  function revokeAudioUrls() {
    state.audioUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.audioUrls.clear();
    if (state.mediaAbort) state.mediaAbort.abort();
    state.mediaAbort = new AbortController();
  }

  function nearBottom() {
    return el.messagesViewport.scrollHeight - el.messagesViewport.scrollTop - el.messagesViewport.clientHeight < 120;
  }
  function scrollBottom(smooth) {
    requestAnimationFrame(function () { el.messagesViewport.scrollTo({ top: el.messagesViewport.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); });
  }

  function renderHistory(forceScroll) {
    var shouldScroll = forceScroll || nearBottom();
    revokeAudioUrls();
    if (!state.history.length) el.messages.innerHTML = '<div class="empty"><p>' + core.escapeHtml(t('noMessages')) + '</p></div>';
    else el.messages.innerHTML = state.history.map(function (item) {
      return core.messageParts(item).map(function (part) { return messageBubble(item, part); }).join('');
    }).join('');
    hydrateAudio();
    el.messages.querySelectorAll('.chat-image').forEach(function (image) {
      image.addEventListener('error', function () {
        var link = image.closest('.chat-image-link');
        if (link) link.classList.add('failed');
        image.remove();
      }, { once: true });
    });
    if (shouldScroll) scrollBottom(!forceScroll);
  }

  function audioClock(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function handleAudioPlayClick(event) {
    var target = event.target && event.target.nodeType === 1 ? event.target : event.target && event.target.parentElement;
    var button = target && target.closest('.audio-play');
    if (!button || !el.messages.contains(button)) return;
    console.log('PLAY BUTTON CLICKED', event.target);
    var wrapper = button.closest('.audio-player');
    var audio = wrapper && wrapper.querySelector('audio');
    if (!audio) return;
    event.preventDefault();
    event.stopPropagation();
    el.messages.querySelectorAll('audio').forEach(function (other) { if (other !== audio) other.pause(); });
    if (!audio.paused) {
      wrapper._audioWantsPlayback = false;
      return audio.pause();
    }
    try {
      wrapper._audioWantsPlayback = true;
      console.log('CALLING AUDIO PLAY', audio);
      var playback = audio.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch(function (error) { console.error('Play Promise failed:', error); });
      }
    } catch (error) {
      console.error('Play Promise failed:', error);
    }
  }

  function bindAudio(wrapper, audio, mediaUrl, onError, forceLoad) {
    var play = wrapper.querySelector('.audio-play');
    var seek = wrapper.querySelector('.audio-seek');
    var duration = wrapper.querySelector('.audio-duration');
    var speed = wrapper.querySelector('.audio-speed');
    function sync() {
      var total = Number.isFinite(audio.duration) ? audio.duration : 0;
      var current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      seek.value = total ? String(Math.round(current / total * 1000)) : '0';
      duration.textContent = audioClock(audio.paused ? total : current);
      play.innerHTML = '<i class="fa-solid fa-' + (audio.paused ? 'play' : 'pause') + '"></i>';
      play.setAttribute('aria-label', audio.paused ? t('play') : t('pause'));
    }
    wrapper._audioOnError = onError;
    if (!wrapper._audioBound) {
      wrapper._audioBound = true;
      audio.addEventListener('error', function () {
        var details = {
          code: audio.error && audio.error.code,
          src: String(audio.currentSrc || audio.src || '').replace(/([?&]token=)[^&]+/i, '$1[redacted]')
        };
        console.error('Audio failed to load', details);
        if (typeof wrapper._audioOnError === 'function') wrapper._audioOnError(details);
      });
      audio.addEventListener('canplay', function () {
        if (!wrapper._audioWantsPlayback || !audio.paused) return;
        var playback = audio.play();
        if (playback && typeof playback.catch === 'function') playback.catch(function (error) { console.error('Play Promise failed:', error); });
      });
      audio.addEventListener('ended', function () { wrapper._audioWantsPlayback = false; });
      seek.addEventListener('input', function () { if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) / 1000 * audio.duration; });
      speed.addEventListener('click', function () {
        var rates = [1, 1.5, 2]; var next = rates[(rates.indexOf(audio.playbackRate) + 1) % rates.length];
        audio.playbackRate = next; speed.textContent = next + 'x';
      });
      ['loadedmetadata', 'loadeddata', 'canplay', 'durationchange', 'timeupdate', 'play', 'pause', 'ended'].forEach(function (event) { audio.addEventListener(event, sync); });
    }
    audio.src = mediaUrl;
    play.disabled = false;
    wrapper.removeAttribute('aria-busy');
    if (forceLoad) audio.load();
    sync();
  }

  function hydrateAudio() {
    var signal = state.mediaAbort.signal;
    el.messages.querySelectorAll('.audio-player[data-audio-id]').forEach(function (wrapper) {
      loadAudio(wrapper, signal, 0);
    });
  }

  async function loadAudio(wrapper, signal, attempt) {
      var id = wrapper.dataset.audioId;
      try {
        if (signal.aborted) return;
        var audio = wrapper.querySelector('audio');
        var mediaToken = chatToken;
        if (!mediaToken) {
          try { mediaToken = String(localStorage.getItem('token_key') || ''); } catch (_) {}
        }
        var query = new URLSearchParams();
        if (mediaToken) query.set('token', mediaToken);
        if (state.activePhone) query.set('phone', state.activePhone);
        query.set('fmt', 'mp4');
        if (attempt) query.set('retry', String(attempt));
        var mediaUrl = endpoint('media', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(id));
        if (query.toString()) mediaUrl += '?' + query.toString();
        bindAudio(wrapper, audio, mediaUrl, function () {
          if (signal.aborted || !wrapper.isConnected) return;
          if (attempt >= 5) {
            wrapper.innerHTML = '<span class="audio-error"><i class="fa-solid fa-circle-exclamation"></i> ' + core.escapeHtml(t('audioFailed')) + '</span>';
            return;
          }
          wrapper.setAttribute('aria-busy', 'true');
          setTimeout(function () {
            if (!signal.aborted && wrapper.isConnected) loadAudio(wrapper, signal, attempt + 1);
          }, Math.min(16000, 1000 * Math.pow(2, attempt)));
        }, attempt > 0);
      } catch (error) {
        if (error.name === 'AbortError' || !wrapper.isConnected) return;
        if (attempt < 5) {
          setTimeout(function () {
            if (!signal.aborted && wrapper.isConnected) loadAudio(wrapper, signal, attempt + 1);
          }, Math.min(16000, 1000 * Math.pow(2, attempt)));
          return;
        }
        wrapper.innerHTML = '<span class="audio-error"><i class="fa-solid fa-circle-exclamation"></i> ' + core.escapeHtml(t('audioFailed')) + '</span>';
      }
  }

  async function loadInbox(force) {
    if (state.inboxBusy) { state.inboxDirty = true; return; }
    state.inboxBusy = true;
    try {
      var data = await getJson(endpoint('inbox', '/' + encodeURIComponent(instanceId) + '?limit=1000'));
      var chats = Array.isArray(data.items) ? data.items : Array.isArray(data.chats) ? data.chats : [];
      chats.forEach(function (chat) {
        var phone = core.normalizePhone(chat && chat.phone);
        if (state.pendingViews[phone] && core.chatState(chat) !== 'new') delete state.pendingViews[phone];
      });
      chats = core.applyPendingViews(chats, Object.keys(state.pendingViews));
      var signature = JSON.stringify(chats.map(function (chat) { return [chat.phone, chat.state, chat.lastAt, chat.lastText, chat.contactName || chat.name, chat.unread, chat.hasOperator, chat.closed, chat.sos, chat.sosUnread, chat.sosExpiresAt]; }));
      state.chats = chats;
      state.inboxRetried = false;
      if (force || signature !== state.inboxSignature) { state.inboxSignature = signature; renderContacts(); renderHeader(); }
      if (state.activePhone && (!currentChat() || (state.activeTab === 'sos' && core.chatColumn(currentChat()) !== 'sos'))) closeChat();
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) { handleAuthFailure(); return; }
      console.error('Inbox load failed for instance', instanceId, error);
      if (force) {
        // Transient failures (deploy restarts) used to stick on "load failed"
        // until a manual refresh. Retry once quietly, then show the error.
        if (!state.inboxRetried) {
          state.inboxRetried = true;
          setTimeout(function () { loadInbox(true); }, 2500);
          return;
        }
        state.inboxRetried = false;
        el.contactList.innerHTML = '<div class="empty"><p>' + core.escapeHtml(t('loadFailed')) + '</p></div>';
      }
    } finally {
      state.inboxBusy = false;
      if (state.inboxDirty) { state.inboxDirty = false; loadInbox(true); }
    }
  }

  async function loadHistory(force, forceScroll) {
    if (!state.activePhone) return;
    if (state.historyBusy) { state.historyDirty = true; return; }
    var requestedPhone = state.activePhone;
    state.historyBusy = true;
    try {
      var data = await getJson(endpoint('history', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(requestedPhone) + '?limit=500'));
      if (requestedPhone !== state.activePhone) return;
      var history = Array.isArray(data.history) ? data.history : Array.isArray(data.items) ? data.items : [];
      var signature = JSON.stringify(history.map(function (item) { return [item.id, item.createdAt, item.role, item.source, item.text, item.type, item.hasMedia, item.mediaType, item.deliveryStatus, item.ack]; }));
      state.history = history;
      if (force || signature !== state.historySignature) { state.historySignature = signature; renderHistory(forceScroll); }
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) { handleAuthFailure(); return; }
      console.error('History load failed for instance', instanceId, error);
      if (requestedPhone === state.activePhone) el.messages.innerHTML = '<div class="empty"><p>' + core.escapeHtml(t('loadFailed')) + '</p></div>';
    } finally {
      state.historyBusy = false;
      if (state.historyDirty && state.activePhone) { state.historyDirty = false; loadHistory(true, false); }
    }
  }

  function setLock(data) {
    var expiresAt = Number(data && data.expiresAt || 0);
    if (expiresAt > 0 && expiresAt < 1e12) expiresAt *= 1000;
    var ttl = Number(data && data.ttl || 0);
    state.lockUntil = expiresAt || (ttl > 0 ? Date.now() + ttl * 1000 : 0);
    renderLock();
  }

  async function loadLock() {
    if (!state.activePhone) { state.lockUntil = 0; return renderLock(); }
    var phone = state.activePhone;
    try {
      var data = await getJson(endpoint('lock', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(phone)));
      if (phone === state.activePhone) setLock(data);
    } catch (_) {}
  }

  function renderLock() {
    var remaining = state.activePhone ? Math.max(0, Math.ceil((state.lockUntil - Date.now()) / 1000)) : 0;
    el.operatorLock.hidden = remaining <= 0;
    el.lockSeconds.textContent = remaining ? remaining + 'с' : '';
  }

  async function markViewed(phone) {
    for (var attempt = 0; attempt < 3; attempt += 1) {
      try {
        await postJson(endpoint('action', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(phone)), { action: 'view' });
        return true;
      } catch (_) {
        if (attempt < 2) await new Promise(function (resolve) { setTimeout(resolve, 250 * Math.pow(2, attempt)); });
      }
    }
    return false;
  }

  function openChat(phone) {
    phone = core.normalizePhone(phone);
    if (!phone) return;
    state.activePhone = phone; state.history = []; state.historySignature = ''; state.lockUntil = 0;
    var chat = currentChat();
    if (chat && chat.sosUnread) chat.sosUnread = false;
    if (chat && core.chatState(chat) === 'new') {
      state.pendingViews[phone] = Date.now();
      chat.state = 'all'; chat.unread = false;
      if (core.chatColumn(chat) !== 'sos') state.activeTab = 'all';
    }
    el.app.classList.add('chat-open'); el.messageInput.value = ''; el.messageInput.style.height = 'auto';
    renderContacts(); renderHeader();
    el.messages.innerHTML = '<div class="empty"><p>' + core.escapeHtml(t('loading')) + '</p></div>';
    loadHistory(true, true); loadLock(); markViewed(phone).then(function (saved) {
      if (!saved) delete state.pendingViews[phone];
      loadInbox(true);
    });
    if (window.innerWidth > 768) el.messageInput.focus();
  }

  function closeChat() {
    state.activePhone = ''; state.history = []; state.historySignature = ''; state.lockUntil = 0;
    revokeAudioUrls(); el.app.classList.remove('chat-open'); renderContacts(); renderHeader(); emptyChat();
  }

  async function chatAction(action) {
    if (!state.activePhone || state.actionBusy) return;
    var prompts = { close: 'confirmArchive', restore: 'confirmRestore', delete: 'confirmDelete' };
    if (prompts[action] && !(await confirmDialog(t(prompts[action])))) return;
    var phone = state.activePhone; state.actionBusy = true; updateComposer();
    try {
      await postJson(endpoint('action', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(phone)), { action: action });
      showToast(t(action === 'close' ? 'archiveDone' : action === 'restore' ? 'restoreDone' : 'deleteDone'));
      state.activeTab = action === 'close' ? 'archive' : action === 'restore' ? 'all' : state.activeTab;
      closeChat(); await loadInbox(true);
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) { handleAuthFailure(); return; }
      showToast(t('actionFailed'), true);
    }
    finally { state.actionBusy = false; updateComposer(); }
  }

  async function sendMessage() {
    var text = el.messageInput.value.trim();
    if (!text || !state.activePhone || state.sending) return;
    var phone = state.activePhone;
    var retry = state.retrySend;
    var requestId = retry && retry.phone === phone && retry.text === text ? retry.requestId
      : (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    state.retrySend = { phone: phone, text: text, requestId: requestId };
    state.sending = true;
    el.messageInput.disabled = true;
    el.sendBtn.disabled = true;
    el.messageInput.value = '';
    updateComposer();
    state.history.push({ id: 'pending-' + Date.now(), role: 'operator', source: 'operator_panel', direction: 'outgoing', text: text, createdAt: Date.now(), deliveryStatus: 'sent' });
    renderHistory(true);
    try {
      var result = await postJson(endpoint('send', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(phone)), { text: text, requestId: requestId });
      state.retrySend = null;
      var lockResult = result && (result.lock || result);
      setLock(lockResult && (lockResult.expiresAt || lockResult.ttl) ? lockResult : { ttl: 60 });
      state.historySignature = ''; state.inboxSignature = '';
      await Promise.all([loadHistory(true, false), loadInbox(true), loadLock()]);
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) { handleAuthFailure(); return; }
      el.messageInput.value = text; showToast(t('sendFailed'), true);
    }
    finally { state.sending = false; updateComposer(); }
  }

  async function refreshAll(feedback) {
    el.refreshBtn.classList.add('refreshing'); el.refreshBtn.disabled = true;
    state.inboxSignature = ''; state.historySignature = '';
    await Promise.all([loadInbox(true), state.activePhone ? loadHistory(true, false) : Promise.resolve(), state.activePhone ? loadLock() : Promise.resolve()]);
    el.refreshBtn.classList.remove('refreshing'); el.refreshBtn.disabled = false;
    if (feedback) showToast(t('refreshed'));
  }

  function scheduleEventRefresh(event) {
    if (event && event.instanceId && event.instanceId !== instanceId) return;
    clearTimeout(state.eventRefreshTimer);
    state.eventRefreshTimer = setTimeout(function () {
      loadInbox(false);
      if (state.activePhone && (!event || !event.phone || core.normalizePhone(event.phone) === state.activePhone)) { loadHistory(false, false); loadLock(); }
    }, 100);
  }

  function parseEventBlock(block) {
    var data = block.split(/\r?\n/).filter(function (line) { return line.indexOf('data:') === 0; }).map(function (line) { return line.slice(5).trimStart(); }).join('\n');
    if (!data) return;
    try { scheduleEventRefresh(JSON.parse(data)); } catch (_) { scheduleEventRefresh(null); }
  }

  async function connectEvents() {
    if (!window.ReadableStream || state.eventAbort) return;
    state.eventAbort = new AbortController();
    try {
      var response = await fetch(endpoint('events', '/' + encodeURIComponent(instanceId)), {
        credentials: 'same-origin', cache: 'no-store', headers: headers({ Accept: 'text/event-stream' }), signal: state.eventAbort.signal
      });
      if (!response.ok || !response.body) throw new Error('SSE_' + response.status);
      state.eventFailures = 0;
      var reader = response.body.getReader(); var decoder = new TextDecoder(); var buffer = '';
      while (true) {
        var chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) { parseEventBlock(buffer.slice(0, boundary)); buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, ''); }
      }
      throw new Error('SSE_CLOSED');
    } catch (error) {
      if (error.name === 'AbortError') return;
      state.eventAbort = null; state.eventFailures += 1;
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectEvents, Math.min(30000, 1000 * Math.pow(2, state.eventFailures)));
    }
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    el.messages.addEventListener('click', handleAudioPlayClick);
    el.messages.addEventListener('click', handleMediaOpenClick);
    el.contactList.addEventListener('click', function (event) { var item = event.target.closest('[data-phone]'); if (item) openChat(item.dataset.phone); });
    el.tabs.addEventListener('click', function (event) {
      var tab = event.target.closest('[data-tab]'); if (!tab) return;
      state.activeTab = tab.dataset.tab;
      if (state.activePhone && core.chatColumn(currentChat()) !== state.activeTab) closeChat();
      else renderContacts();
    });
    el.searchInput.addEventListener('input', renderContacts);
    el.searchInput.addEventListener('keydown', function (event) { if (event.key === 'Enter' && !el.directChat.hidden) { event.preventDefault(); openChat(core.normalizePhone(el.searchInput.value)); } });
    el.directChat.addEventListener('click', function () { openChat(core.normalizePhone(el.searchInput.value)); });
    el.backBtn.addEventListener('click', closeChat);
    el.refreshBtn.addEventListener('click', function () { refreshAll(true); });
    el.langBtn.addEventListener('click', function () {
      state.lang = state.lang === 'kk' ? 'ru' : 'kk'; localStorage.setItem('operator_chat_lang', state.lang);
      renderStaticText(); renderContacts(); renderHeader(); renderHistory(false);
    });
    el.archiveBtn.addEventListener('click', function () { chatAction(core.chatState(currentChat()) === 'archive' ? 'restore' : 'close'); });
    el.deleteBtn.addEventListener('click', function () { chatAction('delete'); });
    el.sendBtn.addEventListener('click', sendMessage);
    el.messageInput.addEventListener('input', function () { el.messageInput.style.height = 'auto'; el.messageInput.style.height = Math.min(120, el.messageInput.scrollHeight) + 'px'; updateComposer(); });
    el.messageInput.addEventListener('keydown', function (event) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
    el.messageInput.addEventListener('focus', function () { setTimeout(syncVisualViewport, 0); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncVisualViewport);
      window.visualViewport.addEventListener('scroll', syncVisualViewport);
    }
    window.addEventListener('resize', syncVisualViewport);
    window.addEventListener('orientationchange', syncVisualViewport);
    window.addEventListener('beforeunload', function () { revokeAudioUrls(); if (state.eventAbort) state.eventAbort.abort(); });
  }

  function syncVisualViewport() {
    var viewport = window.visualViewport;
    var height = viewport ? viewport.height : window.innerHeight;
    var top = viewport ? viewport.offsetTop : 0;
    document.documentElement.style.setProperty('--app-height', Math.max(1, Math.round(height)) + 'px');
    document.documentElement.style.setProperty('--app-top', Math.max(0, Math.round(top)) + 'px');
    if (document.activeElement === el.messageInput) {
      requestAnimationFrame(function () { el.messageInput.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    }
  }

  function start() {
    syncVisualViewport(); renderStaticText(); bindEvents(); renderTabs(); renderHeader(); emptyChat(); refreshAll(false); connectEvents();
    state.pollTimer = setInterval(function () { loadInbox(false); if (state.activePhone) { loadHistory(false, false); loadLock(); } }, 5000);
    state.lockTimer = setInterval(renderLock, 250);
  }

  start();
}());
