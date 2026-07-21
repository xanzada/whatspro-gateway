(function () {
  'use strict';

  var core = window.WhatsProChatCore;
  if (!core) throw new Error('WhatsProChatCore is required');

  var params = new URLSearchParams(window.location.search);
  var config = window.__CHAT_CONFIG__ || {};
  var instanceId = String(params.get('instance') || config.instance || 'prestige').trim();

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
      tabs: { new: 'Жаңа', all: 'Бәрі', operator: 'Опер', archive: 'Архив' },
      select: 'Чатты таңдаңыз', selectHint: 'Толық хат алмасу тарихы осы жерде шығады.',
      noChats: 'Бұл бөлімде чаттар жоқ', noResults: 'Ештеңе табылмады', noMessages: 'Хабарламалар жоқ',
      loading: 'Жүктелуде…', loadFailed: 'Жүктеу мүмкін болмады', reply: 'Жауап жазу…', archived: 'Чат архивте',
      send: 'Жіберу', back: 'Артқа', refresh: 'Жаңарту', refreshed: 'Жаңартылды', sendFailed: 'Хабар жіберілмеді',
      client: 'Клиент', bot: 'Бот', operatorRole: 'Оператор', system: 'Жүйе', unknown: 'Сақталмаған контакт',
      newBadge: 'Жаңа', archiveBadge: 'Архив', operatorBadge: 'Опер', botMuted: 'Бот өшірулі',
      archive: 'Архивке жіберу', restore: 'Архивтен қайтару', remove: 'Біржола өшіру',
      confirmArchive: 'Бұл чатты архивке жіберу керек пе?', confirmRestore: 'Бұл чатты архивтен қайтару керек пе?',
      confirmDelete: 'Чатты және барлық хабарламаны біржола өшіру керек пе? Бұл әрекетті қайтару мүмкін емес.',
      archiveDone: 'Чат архивке жіберілді', restoreDone: 'Чат қайтарылды', deleteDone: 'Чат өшірілді',
      audioFailed: 'Аудио жүктелмеді', play: 'Ойнату', pause: 'Кідірту', direct: function (phone) { return '+' + phone + ' нөміріне жазу'; }
    },
    ru: {
      title: 'Чат оператора', operator: 'Оператор', search: 'Поиск по имени, телефону или сообщению',
      tabs: { new: 'Новые', all: 'Все', operator: 'Опер', archive: 'Архив' },
      select: 'Выберите чат', selectHint: 'Здесь появится полная история сообщений.',
      noChats: 'В этом разделе нет чатов', noResults: 'Ничего не найдено', noMessages: 'Нет сообщений',
      loading: 'Загрузка…', loadFailed: 'Не удалось загрузить', reply: 'Написать ответ…', archived: 'Чат в архиве',
      send: 'Отправить', back: 'Назад', refresh: 'Обновить', refreshed: 'Обновлено', sendFailed: 'Сообщение не отправлено',
      client: 'Клиент', bot: 'Бот', operatorRole: 'Оператор', system: 'Система', unknown: 'Несохранённый контакт',
      newBadge: 'Новое', archiveBadge: 'Архив', operatorBadge: 'Опер', botMuted: 'Бот отключён',
      archive: 'Отправить в архив', restore: 'Вернуть из архива', remove: 'Удалить навсегда',
      confirmArchive: 'Отправить этот чат в архив?', confirmRestore: 'Вернуть этот чат из архива?',
      confirmDelete: 'Навсегда удалить чат и все сообщения? Это действие нельзя отменить.',
      archiveDone: 'Чат отправлен в архив', restoreDone: 'Чат восстановлен', deleteDone: 'Чат удалён',
      audioFailed: 'Не удалось загрузить аудио', play: 'Воспроизвести', pause: 'Пауза', direct: function (phone) { return 'Написать +' + phone; }
    }
  };

  var el = {};
  ['app', 'instance-title', 'lang-btn', 'refresh-btn', 'search-input', 'tabs', 'direct-chat', 'contact-list',
    'back-btn', 'active-name', 'active-meta', 'operator-lock', 'lock-seconds', 'archive-btn', 'delete-btn',
    'messages-viewport', 'messages', 'message-input', 'send-btn', 'toast'].forEach(function (id) {
    el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id);
  });

  var state = {
    lang: localStorage.getItem('operator_chat_lang') === 'ru' ? 'ru' : 'kk',
    chats: [], activeTab: 'new', activePhone: '', history: [],
    inboxBusy: false, historyBusy: false, inboxDirty: false, historyDirty: false, actionBusy: false, sending: false,
    inboxSignature: '', historySignature: '', lockUntil: 0,
    pollTimer: 0, lockTimer: 0, reconnectTimer: 0, eventAbort: null, eventFailures: 0,
    eventRefreshTimer: 0, toastTimer: 0, mediaAbort: null, audioUrls: new Map(), retrySend: null
  };

  function t(key) { return dictionary[state.lang][key] == null ? key : dictionary[state.lang][key]; }
  function headers(extra) {
    return Object.assign({}, chatToken ? { 'x-chat-token': chatToken, 'x-chat-instance': instanceId } : {}, extra || {});
  }
  function endpoint(name, suffix) { return apiBase + endpoints[name] + (suffix || ''); }

  async function requestJson(url, options) {
    var response = await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}, {
      headers: headers(Object.assign({ Accept: 'application/json' }, options && options.headers || {}))
    }));
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(data.error || 'HTTP_' + response.status);
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

  function chatMatchesTab(chat) { return core.chatState(chat) === state.activeTab; }

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
    var counts = { new: 0, all: 0, operator: 0, archive: 0 };
    state.chats.forEach(function (chat) { var key = core.chatState(chat); if (counts[key] != null) counts[key] += 1; });
    el.tabs.innerHTML = ['new', 'all', 'operator', 'archive'].map(function (key) {
      return '<button class="tab" type="button" role="tab" aria-selected="' + (state.activeTab === key) + '" data-tab="' + key + '">' +
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
      var name = contactName(chat) || t('unknown');
      var badge = tabState === 'new' ? t('newBadge') : tabState === 'operator' ? t('operatorBadge') : tabState === 'archive' ? t('archiveBadge') : '';
      return '<button type="button" class="contact-item ' + tabState + (phone === state.activePhone ? ' active' : '') + '" data-phone="' + core.escapeHtml(phone) + '">' +
        '<span class="contact-avatar"><i class="fa-solid fa-user"></i></span><span class="contact-copy">' +
        '<span class="contact-name truncate">' + core.escapeHtml(name) + '</span><span class="contact-phone truncate">+' + core.escapeHtml(phone) + '</span>' +
        '<span class="contact-snippet truncate">' + core.escapeHtml(chat.lastText || chat.lastMessage || t('noMessages')) + '</span></span>' +
        '<span class="contact-meta"><span class="contact-time">' + core.escapeHtml(core.formatTime(chat.lastAt || chat.updatedAt, state.lang)) + '</span>' +
        (badge ? '<span class="badge">' + core.escapeHtml(badge) + '</span>' : '') + '</span></button>';
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
    el.instanceTitle.textContent = instanceId.toUpperCase();
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
    var archived = core.chatState(currentChat()) === 'archive';
    var disabled = !state.activePhone || archived || state.sending || state.actionBusy;
    el.messageInput.disabled = disabled;
    el.messageInput.placeholder = archived ? t('archived') : t('reply');
    el.sendBtn.disabled = disabled || !el.messageInput.value.trim();
  }

  function renderReceipt(item, role) {
    if (role !== 'bot' && role !== 'operator') return '';
    var receipt = core.receiptState({ ack: item.ack, ackStatus: item.ackStatus, status: item.deliveryStatus || item.status });
    return '<span class="ticks ' + receipt + '" aria-label="' + receipt + '">' + (receipt === 'sent' ? '✓' : '✓✓') + '</span>';
  }

  function messageBubble(item, part) {
    var role = core.roleOf(item);
    var label = role === 'client' ? t('client') : role === 'bot' ? t('bot') : role === 'operator' ? t('operatorRole') : t('system');
    var timestamp = core.formatTime(item.createdAt || item.timestamp || item.sentAt, state.lang);
    var content = '';
    if (part.kind === 'text') content = '<div class="message-text">' + core.escapeHtml(part.text) + '</div>';
    if (part.kind === 'audio') {
      content = '<div class="audio-player" data-audio-id="' + core.escapeHtml(part.id) + '" aria-busy="true"><audio preload="auto" playsinline></audio>' +
        '<button class="audio-play" type="button" aria-label="' + core.escapeHtml(t('play')) + '"><i class="fa-solid fa-play"></i></button>' +
        '<input class="audio-seek" type="range" min="0" max="1000" value="0" aria-label="Seek"><span class="audio-duration">0:00</span>' +
        '<button class="audio-speed" type="button">1x</button></div>';
    }
    return '<div class="message-row ' + role + '"><div class="bubble ' + (part.kind === 'audio' ? 'audio-bubble' : '') + '">' +
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
    if (shouldScroll) scrollBottom(!forceScroll);
  }

  function audioClock(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  function handleAudioPlayClick(event) {
    var button = event.target.closest('.audio-play');
    if (!button || !el.messages.contains(button)) return;
    var wrapper = button.closest('.audio-player');
    var audio = wrapper && wrapper.querySelector('audio');
    if (!audio) return;
    event.preventDefault();
    el.messages.querySelectorAll('audio').forEach(function (other) { if (other !== audio) other.pause(); });
    if (!audio.paused) return audio.pause();
    try {
      var playback = audio.play();
      if (playback && typeof playback.catch === 'function') {
        playback.catch(function (error) { console.error('Audio play error:', error); });
      }
    } catch (error) {
      console.error('Audio play error:', error);
    }
  }

  function bindAudio(wrapper, audio, objectUrl) {
    var play = wrapper.querySelector('.audio-play');
    var seek = wrapper.querySelector('.audio-seek');
    var duration = wrapper.querySelector('.audio-duration');
    var speed = wrapper.querySelector('.audio-speed');
    audio.src = objectUrl;
    function sync() {
      var total = Number.isFinite(audio.duration) ? audio.duration : 0;
      var current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      seek.value = total ? String(Math.round(current / total * 1000)) : '0';
      duration.textContent = audioClock(audio.paused ? total : current);
      play.innerHTML = '<i class="fa-solid fa-' + (audio.paused ? 'play' : 'pause') + '"></i>';
      play.setAttribute('aria-label', audio.paused ? t('play') : t('pause'));
    }
    seek.addEventListener('input', function () { if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) / 1000 * audio.duration; });
    speed.addEventListener('click', function () {
      var rates = [1, 1.5, 2]; var next = rates[(rates.indexOf(audio.playbackRate) + 1) % rates.length];
      audio.playbackRate = next; speed.textContent = next + 'x';
    });
    ['loadedmetadata', 'loadeddata', 'canplay', 'durationchange', 'timeupdate', 'play', 'pause', 'ended'].forEach(function (event) { audio.addEventListener(event, sync); });
    play.disabled = false;
    wrapper.removeAttribute('aria-busy');
    audio.load();
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
        var mediaUrl = endpoint('media', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(id));
        bindAudio(wrapper, wrapper.querySelector('audio'), mediaUrl);
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
      var data = await getJson(endpoint('inbox', '/' + encodeURIComponent(instanceId) + '?limit=500'));
      var chats = Array.isArray(data.items) ? data.items : Array.isArray(data.chats) ? data.chats : [];
      var signature = JSON.stringify(chats.map(function (chat) { return [chat.phone, chat.state, chat.lastAt, chat.lastText, chat.contactName || chat.name, chat.unread, chat.hasOperator, chat.closed]; }));
      state.chats = chats;
      if (force || signature !== state.inboxSignature) { state.inboxSignature = signature; renderContacts(); renderHeader(); }
      if (state.activePhone && !currentChat()) closeChat();
    } catch (error) {
      if (force) el.contactList.innerHTML = '<div class="empty"><p>' + core.escapeHtml(t('loadFailed')) + '</p></div>';
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
      var signature = JSON.stringify(history.map(function (item) { return [item.id, item.createdAt, item.role, item.source, item.text, item.type, item.mediaType, item.deliveryStatus, item.ack]; }));
      state.history = history;
      if (force || signature !== state.historySignature) { state.historySignature = signature; renderHistory(forceScroll); }
    } catch (error) {
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
    try { await postJson(endpoint('action', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(phone)), { action: 'view' }); }
    catch (_) {}
  }

  function openChat(phone) {
    phone = core.normalizePhone(phone);
    if (!phone) return;
    state.activePhone = phone; state.history = []; state.historySignature = ''; state.lockUntil = 0;
    var chat = currentChat();
    if (chat && core.chatState(chat) === 'new') { chat.state = 'all'; chat.unread = false; state.activeTab = 'all'; }
    el.app.classList.add('chat-open'); el.messageInput.value = ''; el.messageInput.style.height = 'auto';
    renderContacts(); renderHeader();
    el.messages.innerHTML = '<div class="empty"><p>' + core.escapeHtml(t('loading')) + '</p></div>';
    loadHistory(true, true); loadLock(); markViewed(phone).then(function () { loadInbox(true); });
    if (window.innerWidth > 768) el.messageInput.focus();
  }

  function closeChat() {
    state.activePhone = ''; state.history = []; state.historySignature = ''; state.lockUntil = 0;
    revokeAudioUrls(); el.app.classList.remove('chat-open'); renderContacts(); renderHeader(); emptyChat();
  }

  async function chatAction(action) {
    if (!state.activePhone || state.actionBusy) return;
    var prompts = { close: 'confirmArchive', restore: 'confirmRestore', delete: 'confirmDelete' };
    if (prompts[action] && !window.confirm(t(prompts[action]))) return;
    var phone = state.activePhone; state.actionBusy = true; updateComposer();
    try {
      await postJson(endpoint('action', '/' + encodeURIComponent(instanceId) + '/' + encodeURIComponent(phone)), { action: action });
      showToast(t(action === 'close' ? 'archiveDone' : action === 'restore' ? 'restoreDone' : 'deleteDone'));
      state.activeTab = action === 'close' ? 'archive' : action === 'restore' ? 'all' : state.activeTab;
      closeChat(); await loadInbox(true);
    } catch (error) { showToast(error.message, true); }
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
    } catch (error) { el.messageInput.value = text; showToast(t('sendFailed'), true); }
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
    el.messages.addEventListener('click', handleAudioPlayClick);
    el.contactList.addEventListener('click', function (event) { var item = event.target.closest('[data-phone]'); if (item) openChat(item.dataset.phone); });
    el.tabs.addEventListener('click', function (event) {
      var tab = event.target.closest('[data-tab]'); if (!tab) return;
      state.activeTab = tab.dataset.tab;
      if (state.activePhone && core.chatState(currentChat()) !== state.activeTab) closeChat();
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
