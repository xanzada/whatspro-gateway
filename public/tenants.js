(function () {
  'use strict';

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  var viewEl = $('#view');
  var modalRoot = $('#modal-root');
  var appShell = $('#app-shell');
  var searchEl = $('#global-search');
  var report = { tenants: [], total: 0 };
  var instances = [];
  var settings = new Map();
  var statuses = new Map();
  var currentView = 'dashboard';
  var currentDetail = '';
  var searchQuery = '';
  var activeFilter = 'all';
  var openMenuId = '';
  var loading = false;
  var lastSync = null;
  var lastInstanceSignature = '';
  var statusTimer = 0;
  var instanceTimer = 0;
  var qrTimer = 0;
  var qrInstanceId = '';
  var previousFocus = null;
  var defaults = { domainSuffix: '', workHours: '09:00 - 03:00' };
  var locale = localStorage.getItem('whatspro_locale') === 'ru' ? 'ru' : 'kk';
  var theme = localStorage.getItem('whatspro_theme') === 'light' ? 'light' : 'dark';

  var ICONS = {
    plus: 'i-plus', store: 'i-store', power: 'i-power', plug: 'i-plug', clock: 'i-clock',
    eye: 'i-eye', edit: 'i-edit', restart: 'i-restart', link: 'i-link', qr: 'i-qr',
    trash: 'i-trash', check: 'i-check', close: 'i-close', alert: 'i-alert',
    back: 'i-arrow-left', refresh: 'i-refresh', copy: 'i-copy', spark: 'i-spark'
  };

  var I18N = {
    kk: {
      documentTitle: 'WhatsPro — Ресторандарды басқару',
      dashboard: 'Басқару панелі', restaurants: 'Ресторандар', workspace: 'Жұмыс кеңістігі',
      platform: 'Ресторан платформасы', primaryNavigation: 'Негізгі навигация',
      collapseSidebar: 'Бүйірлік панельді жинау', openNavigation: 'Навигацияны ашу',
      lightMode: 'Жарық режим', darkMode: 'Қараңғы режим', gatewayReady: 'Gateway қолжетімді',
      checking: 'Тексерілуде…', syncedNow: 'Қазір синхрондалды', synced: 'Синхрондалды',
      searchPlaceholder: 'Ресторан, instance немесе телефон іздеу…', changeLanguage: 'Тілді ауыстыру',
      admin: 'Әкімші', owner: 'Иесі', adminPanel: 'Әкімші панелі', secureSession: 'Қауіпсіз сессия',
      refreshData: 'Деректерді жаңарту', logout: 'Шығу', refresh: 'Жаңарту',
      operations: 'ЖҰМЫС ШОЛУЫ', dashboardTitle: 'Басқару панелі',
      dashboardCopy: 'Барлық ресторанның WhatsApp байланысын бір жерден бақылаңыз.',
      addRestaurant: 'Ресторан қосу', restaurantCount: 'Ресторандар', active: 'Белсенді',
      connected: 'Қосылған', attention: 'Назар қажет', allGateway: 'Осы gateway ішіндегі барлық нүкте',
      enabledLocations: 'Қосылған ресторандар', liveSessions: 'WhatsApp сессиясы онлайн',
      requireAction: 'Қосылуды қажет етеді', recentRestaurants: 'Соңғы ресторандар', shown: 'көрсетілді',
      restaurant: 'Ресторан', instance: 'Instance', phone: 'Телефон', status: 'Күйі',
      aiPrompt: 'AI промпт', created: 'Құрылған', noRestaurants: 'Ресторандар әлі жоқ',
      noRestaurantsCopy: 'Алғашқы ресторанды қосып, WhatsApp сессиясын байланыстырыңыз.',
      restaurantDirectory: 'РЕСТОРАНДАР ТІЗІМІ', restaurantsTitle: 'Ресторандар',
      restaurantsCopy: 'Ресторандар мен олардың нақты WhatsApp күйін басқарыңыз.',
      all: 'Барлығы', connectedFilter: 'Қосылған', attentionFilter: 'Назар қажет',
      results: 'нәтиже', paused: 'Тоқтатылған', qrRequired: 'QR қажет',
      connecting: 'Қосылуда', offline: 'Қосылмаған', unknown: 'Тексерілуде',
      whatsappSource: 'WhatsPro сессиясы', sharedPrompt: 'Ортақ промпт',
      actions: 'Әрекеттер', viewDetails: 'Толығырақ', edit: 'Өзгерту',
      restart: 'Қайта іске қосу', reconnect: 'Қайта қосу', qrCode: 'QR код', delete: 'Өшіру',
      general: 'Жалпы', whatsapp: 'WhatsApp', prompt: 'Промпт', health: 'Күй',
      configuration: 'Конфигурация', back: 'Артқа', address: 'Мекенжай', hours: 'Жұмыс уақыты',
      domain: 'Домен', source: 'Дереккөзі', lastCheck: 'Соңғы тексеру', liveStatus: 'Нақты күй',
      liveStatusCopy: 'Бұл күй WhatsPro сессиясынан тікелей алынды.',
      qrTitle: 'WhatsApp-ты байланыстыру', qrCopy: 'Телефоныңызда WhatsApp → Байланыстырылған құрылғылар → Құрылғыны байланыстыру бөлімін ашып, осы кодты сканерлеңіз.',
      qrWaiting: 'QR код дайындалуда…', qrConnected: 'WhatsApp сәтті қосылды', qrStart: 'Сессия іске қосылуда…',
      qrUnavailable: 'QR әлі дайын емес. Бірнеше секунд күтіңіз.', newRestaurant: 'Жаңа ресторан',
      fourSteps: 'Төрт қысқа қадам. Техникалық баптаулар автоматты орындалады.',
      nameStep: 'Атауы', phoneStep: 'Телефон', promptStep: 'Промпт', reviewStep: 'Тексеру',
      restaurantName: 'Ресторан атауы', optional: 'міндетті емес', continue: 'Жалғастыру',
      cancel: 'Бас тарту', nameHint: 'Instance ID осы атаудан автоматты жасалады.',
      phoneHint: 'Бос қалдырсаңыз, нөмірді QR сканерлегеннен кейін қосуға болады.',
      hoursHint: 'Мысалы: 09:00 - 23:00', domainHint: 'Бос қалдырсаңыз, атаудан жасалады.',
      systemPrompt: 'AI жүйелік промпт', promptHint: 'Бос қалдырсаңыз, ортақ промпт қолданылады.',
      createRestaurant: 'Ресторанды құру', startImmediately: 'WhatsApp сессиясын бірден іске қосу',
      creating: 'Құрылуда', creatingCopy: 'Ресторан және WhatsPro сессиясы бір уақытта жасалады.',
      savingRecord: 'Ресторан жазбасы сақталуда', syncingInstance: 'WhatsPro-мен синхрондалуда',
      startingWhatsapp: 'WhatsApp іске қосылуда', ready: 'Дайын',
      readyCopy: 'Ресторан құрылды. Қосылу үшін QR кодты сканерлеңіз.',
      close: 'Жабу', showQr: 'QR көрсету', requiredField: 'Бұл өрісті толтырыңыз.',
      actionDone: 'Әрекет орындалды', actionFailed: 'Әрекет орындалмады',
      refreshed: 'Деректер жаңартылды', loadFailed: 'Деректерді жүктеу мүмкін болмады',
      retry: 'Қайта көру', editRestaurant: 'Ресторанды өзгерту', save: 'Сақтау',
      saved: 'Өзгерістер сақталды', deleteTitle: 'Ресторанды өшіру',
      deleteCopy: 'Бұл әрекет ресторан жазбасын және WhatsApp сессиясын өшіреді.',
      typeInstance: 'Өшіруді растау үшін instance ID жазыңыз:', deleteForever: 'Біржола өшіру',
      deleted: 'Ресторан өшірілді', copyDone: 'Көшірілді', virtualTenant: 'WhatsPro-дан табылды',
      menuFor: 'Ресторан әрекеттері', noPhone: 'Телефон көрсетілмеген', notSet: 'Көрсетілмеген',
      realTime: 'Нақты уақытта', signOutFailed: 'Шығу мүмкін болмады', sessionExpired: 'Әкімші сессиясының мерзімі аяқталды.',
      instanceExists: 'Бұл instance WhatsPro тізімінде бар', instanceMissing: 'WhatsPro тізімінде жоқ',
      statusConnected: 'connected', statusQr: 'qr_ready', statusOffline: 'offline'
    },
    ru: {
      documentTitle: 'WhatsPro — Управление ресторанами',
      dashboard: 'Панель управления', restaurants: 'Рестораны', workspace: 'Рабочее пространство',
      platform: 'Платформа для ресторанов', primaryNavigation: 'Основная навигация',
      collapseSidebar: 'Свернуть боковую панель', openNavigation: 'Открыть навигацию',
      lightMode: 'Светлая тема', darkMode: 'Тёмная тема', gatewayReady: 'Gateway доступен',
      checking: 'Проверка…', syncedNow: 'Синхронизировано сейчас', synced: 'Синхронизировано',
      searchPlaceholder: 'Поиск по ресторану, instance или телефону…', changeLanguage: 'Сменить язык',
      admin: 'Администратор', owner: 'Владелец', adminPanel: 'Панель администратора', secureSession: 'Защищённая сессия',
      refreshData: 'Обновить данные', logout: 'Выйти', refresh: 'Обновить',
      operations: 'ОБЗОР РАБОТЫ', dashboardTitle: 'Панель управления',
      dashboardCopy: 'Контролируйте WhatsApp-подключения всех ресторанов в одном месте.',
      addRestaurant: 'Добавить ресторан', restaurantCount: 'Рестораны', active: 'Активные',
      connected: 'Подключены', attention: 'Требуют внимания', allGateway: 'Все точки этого gateway',
      enabledLocations: 'Включённые рестораны', liveSessions: 'WhatsApp-сессии онлайн',
      requireAction: 'Требуют подключения', recentRestaurants: 'Последние рестораны', shown: 'показано',
      restaurant: 'Ресторан', instance: 'Instance', phone: 'Телефон', status: 'Статус',
      aiPrompt: 'AI-промпт', created: 'Создан', noRestaurants: 'Ресторанов пока нет',
      noRestaurantsCopy: 'Добавьте первый ресторан и подключите WhatsApp-сессию.',
      restaurantDirectory: 'СПИСОК РЕСТОРАНОВ', restaurantsTitle: 'Рестораны',
      restaurantsCopy: 'Управляйте ресторанами и их фактическим состоянием WhatsApp.',
      all: 'Все', connectedFilter: 'Подключены', attentionFilter: 'Требуют внимания',
      results: 'результатов', paused: 'Приостановлен', qrRequired: 'Нужен QR',
      connecting: 'Подключается', offline: 'Не подключён', unknown: 'Проверяется',
      whatsappSource: 'Сессия WhatsPro', sharedPrompt: 'Общий промпт',
      actions: 'Действия', viewDetails: 'Подробнее', edit: 'Изменить',
      restart: 'Перезапустить', reconnect: 'Подключить заново', qrCode: 'QR-код', delete: 'Удалить',
      general: 'Общее', whatsapp: 'WhatsApp', prompt: 'Промпт', health: 'Состояние',
      configuration: 'Конфигурация', back: 'Назад', address: 'Адрес', hours: 'Часы работы',
      domain: 'Домен', source: 'Источник', lastCheck: 'Последняя проверка', liveStatus: 'Фактический статус',
      liveStatusCopy: 'Этот статус получен напрямую из сессии WhatsPro.',
      qrTitle: 'Подключить WhatsApp', qrCopy: 'Откройте WhatsApp → Связанные устройства → Привязка устройства и отсканируйте этот код.',
      qrWaiting: 'QR-код подготавливается…', qrConnected: 'WhatsApp успешно подключён', qrStart: 'Сессия запускается…',
      qrUnavailable: 'QR ещё не готов. Подождите несколько секунд.', newRestaurant: 'Новый ресторан',
      fourSteps: 'Четыре коротких шага. Технические настройки выполняются автоматически.',
      nameStep: 'Название', phoneStep: 'Телефон', promptStep: 'Промпт', reviewStep: 'Проверка',
      restaurantName: 'Название ресторана', optional: 'необязательно', continue: 'Продолжить',
      cancel: 'Отмена', nameHint: 'Instance ID будет создан автоматически из названия.',
      phoneHint: 'Оставьте пустым, чтобы привязать номер после сканирования QR.',
      hoursHint: 'Например: 09:00 - 23:00', domainHint: 'Если оставить пустым, создастся из названия.',
      systemPrompt: 'Системный AI-промпт', promptHint: 'Если оставить пустым, будет использован общий промпт.',
      createRestaurant: 'Создать ресторан', startImmediately: 'Сразу запустить WhatsApp-сессию',
      creating: 'Создание', creatingCopy: 'Ресторан и сессия WhatsPro создаются вместе.',
      savingRecord: 'Сохраняется запись ресторана', syncingInstance: 'Синхронизация с WhatsPro',
      startingWhatsapp: 'Запуск WhatsApp', ready: 'Готово',
      readyCopy: 'Ресторан создан. Отсканируйте QR-код для подключения.',
      close: 'Закрыть', showQr: 'Показать QR', requiredField: 'Заполните это поле.',
      actionDone: 'Действие выполнено', actionFailed: 'Не удалось выполнить действие',
      refreshed: 'Данные обновлены', loadFailed: 'Не удалось загрузить данные',
      retry: 'Повторить', editRestaurant: 'Изменить ресторан', save: 'Сохранить',
      saved: 'Изменения сохранены', deleteTitle: 'Удалить ресторан',
      deleteCopy: 'Это действие удалит запись ресторана и его WhatsApp-сессию.',
      typeInstance: 'Для подтверждения введите instance ID:', deleteForever: 'Удалить навсегда',
      deleted: 'Ресторан удалён', copyDone: 'Скопировано', virtualTenant: 'Найден в WhatsPro',
      menuFor: 'Действия ресторана', noPhone: 'Телефон не указан', notSet: 'Не указано',
      realTime: 'В реальном времени', signOutFailed: 'Не удалось выйти', sessionExpired: 'Сессия администратора истекла.',
      instanceExists: 'Instance есть в списке WhatsPro', instanceMissing: 'Instance отсутствует в WhatsPro',
      statusConnected: 'connected', statusQr: 'qr_ready', statusOffline: 'offline'
    }
  };

  function t(key) { return (I18N[locale] && I18N[locale][key]) || key; }
  function icon(name) { return '<svg aria-hidden="true"><use href="#' + (ICONS[name] || name) + '"></use></svg>'; }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function attr(value) { return escapeHtml(value).replace(/`/g, '&#096;'); }
  function delay(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }
  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
  }
  function slugify(value) {
    var translit = {'а':'a','ә':'a','б':'b','в':'v','г':'g','ғ':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'i','к':'k','қ':'q','л':'l','м':'m','н':'n','ң':'n','о':'o','ө':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ұ':'u','ү':'u','ф':'f','х':'h','һ':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','і':'i','ь':'','э':'e','ю':'yu','я':'ya'};
    return String(value || '').toLowerCase().split('').map(function (letter) {
      return Object.prototype.hasOwnProperty.call(translit, letter) ? translit[letter] : letter;
    }).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
  }
  function formatTime(value) {
    if (!value) return '—';
    try { return new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'kk-KZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch (error) { return '—'; }
  }
  function formatSync() {
    if (loading || !lastSync) return t('checking');
    var seconds = Math.max(0, Math.floor((Date.now() - lastSync.getTime()) / 1000));
    if (seconds < 20) return t('syncedNow');
    return t('synced') + ' · ' + (seconds < 60 ? seconds + ' сек' : Math.floor(seconds / 60) + ' мин');
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    }).then(function (response) {
      return response.text().then(function (raw) {
        var data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (error) { data = { error: raw.slice(0, 240) }; }
        if (!response.ok) {
          var message = response.status === 401 ? t('sessionExpired') : (data.message || data.error || ('HTTP ' + response.status));
          var requestError = new Error(message);
          requestError.fields = data.fields || [];
          requestError.status = response.status;
          throw requestError;
        }
        return data;
      });
    });
  }
  function toast(title, message, bad) {
    var node = document.createElement('div');
    node.className = 'toast' + (bad ? ' bad' : '');
    node.innerHTML = '<span class="mark">' + icon(bad ? 'alert' : 'check') + '</span><div><strong>' +
      escapeHtml(title) + '</strong><span>' + escapeHtml(message || '') + '</span></div>';
    $('#toast-region').appendChild(node);
    window.setTimeout(function () { node.remove(); }, bad ? 5200 : 3000);
  }

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('whatspro_theme', theme);
    var use = $('#focus-mode use');
    if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
    $('#theme-label').textContent = theme === 'dark' ? t('lightMode') : t('darkMode');
    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#090c0f' : '#f4f7f8');
  }
  function applyStaticTranslations() {
    document.documentElement.lang = locale;
    document.title = t('documentTitle');
    $('#nav-dashboard').textContent = t('dashboard');
    $('#nav-restaurants').textContent = t('restaurants');
    $('#brand-subtitle').textContent = t('platform');
    $('.nav-label').textContent = t('workspace');
    $('.main-nav').setAttribute('aria-label', t('primaryNavigation'));
    $('#sidebar-toggle').setAttribute('aria-label', t('collapseSidebar'));
    $('#mobile-menu').setAttribute('aria-label', t('openNavigation'));
    $('#gateway-label').textContent = t('gatewayReady');
    $('#last-sync').textContent = formatSync();
    searchEl.placeholder = t('searchPlaceholder');
    $('#locale-button').setAttribute('aria-label', t('changeLanguage'));
    $('#locale-button span').textContent = locale === 'ru' ? 'РУС' : 'ҚАЗ';
    $$('#locale-menu [data-locale]').forEach(function (button) { button.classList.toggle('active', button.dataset.locale === locale); });
    $('#profile-name').textContent = t('admin');
    $('#profile-role').textContent = t('owner');
    $('#profile-workspace').textContent = t('adminPanel');
    $('#profile-session').textContent = t('secureSession');
    $('#profile-refresh').textContent = t('refreshData');
    $('#profile-logout').textContent = t('logout');
    $('#refresh-button').setAttribute('aria-label', t('refresh'));
    applyTheme();
  }

  function tenantStatus(tenant) {
    if (tenant.active === false) return { label: t('paused'), cls: 'neutral', key: 'paused' };
    var live = statuses.get(tenant.instanceId);
    if (!live || live.__error) return { label: t('unknown'), cls: 'info', key: 'checking' };
    var value = String(live.status || '').toLowerCase();
    if (value === 'connected') return { label: t('connected'), cls: 'success', key: 'connected' };
    if (value === 'qr_ready' || value === 'qr_required') return { label: t('qrRequired'), cls: 'warning', key: 'qr' };
    if (value === 'starting' || value === 'initializing' || value === 'restoring_session') return { label: t('connecting'), cls: 'info', key: 'connecting' };
    return { label: t('offline'), cls: 'danger', key: 'offline' };
  }
  function filteredTenants() {
    var query = searchQuery.trim().toLowerCase();
    return report.tenants.filter(function (tenant) {
      var detail = settings.get(tenant.instanceId) || {};
      var state = tenantStatus(tenant);
      var haystack = [tenant.brand, tenant.instanceId, detail.whatsappPhone, detail.domain, state.label].join(' ').toLowerCase();
      var queryMatch = !query || haystack.indexOf(query) >= 0;
      var filterMatch = activeFilter === 'all' || (activeFilter === 'connected' && state.key === 'connected') ||
        (activeFilter === 'attention' && state.key !== 'connected');
      return queryMatch && filterMatch;
    });
  }
  function counts() {
    return {
      total: report.tenants.length,
      active: report.tenants.filter(function (item) { return item.active !== false; }).length,
      connected: report.tenants.filter(function (item) { return tenantStatus(item).key === 'connected'; }).length,
      attention: report.tenants.filter(function (item) { var key = tenantStatus(item).key; return key !== 'connected' && key !== 'paused'; }).length
    };
  }
  function updateChrome() {
    $('#restaurant-count').textContent = String(report.tenants.length);
    $('#last-sync').textContent = formatSync();
  }
  function patchLiveDom() {
    $$('#view [data-live-status]').forEach(function (node) {
      var tenant = report.tenants.find(function (item) { return item.instanceId === node.dataset.liveStatus; });
      if (!tenant) return;
      var state = tenantStatus(tenant);
      node.className = 'badge ' + state.cls;
      node.textContent = state.label;
    });
    var c = counts();
    if ($('#stat-connected')) $('#stat-connected').textContent = String(c.connected);
    if ($('#stat-attention')) $('#stat-attention').textContent = String(c.attention);
    if ($('#detail-live-status') && currentDetail) {
      var detailTenant = report.tenants.find(function (item) { return item.instanceId === currentDetail; });
      if (detailTenant) $('#detail-live-status').textContent = tenantStatus(detailTenant).label;
    }
    updateChrome();
  }

  function pageHeader(eyebrow, title, copy, actionHtml) {
    return '<div class="page-header"><div><div class="eyebrow">' + escapeHtml(eyebrow) + '</div><h1>' +
      escapeHtml(title) + '</h1><p>' + escapeHtml(copy) + '</p></div><div class="header-actions">' +
      (actionHtml || '') + '</div></div>';
  }
  function addButton() {
    return '<button class="button primary" type="button" data-action="new">' + icon('plus') + '<span>' + t('addRestaurant') + '</span></button>';
  }
  function statCard(label, value, copy, iconName, color, id) {
    return '<article class="stat-card"><span class="stat-label">' + escapeHtml(label) + '</span><span class="stat-icon ' +
      (color || '') + '">' + icon(iconName) + '</span><strong' + (id ? ' id="' + id + '"' : '') + '>' +
      escapeHtml(value) + '</strong><small>' + escapeHtml(copy) + '</small></article>';
  }
  function emptyState() {
    return '<div class="empty-state"><span class="empty-icon">' + icon('store') + '</span><strong>' +
      t('noRestaurants') + '</strong><p>' + t('noRestaurantsCopy') + '</p>' + addButton() + '</div>';
  }
  function actionMenu(tenant) {
    if (openMenuId !== tenant.instanceId) return '';
    return '<div class="action-menu popover">' +
      actionButtons(tenant, false) + '</div>';
  }
  function actionButtons(tenant, sheet) {
    var html = '<button type="button" data-action="details" data-instance="' + attr(tenant.instanceId) + '">' + icon('eye') + '<span>' + t('viewDetails') + '</span></button>';
    if (!tenant.virtual) html += '<button type="button" data-action="edit" data-instance="' + attr(tenant.instanceId) + '">' + icon('edit') + '<span>' + t('edit') + '</span></button>';
    html += (sheet ? '<div class="menu-rule"></div>' : '') +
      '<button type="button" data-action="restart" data-instance="' + attr(tenant.instanceId) + '">' + icon('restart') + '<span>' + t('restart') + '</span></button>' +
      '<button type="button" data-action="reconnect" data-instance="' + attr(tenant.instanceId) + '">' + icon('link') + '<span>' + t('reconnect') + '</span></button>' +
      '<button type="button" data-action="qr" data-instance="' + attr(tenant.instanceId) + '">' + icon('qr') + '<span>' + t('qrCode') + '</span></button>';
    if (!tenant.virtual) html += (sheet ? '<div class="menu-rule"></div>' : '') +
      '<button class="danger" type="button" data-action="delete" data-instance="' + attr(tenant.instanceId) + '">' + icon('trash') + '<span>' + t('delete') + '</span></button>';
    return html;
  }
  function tenantRows(items) {
    return items.map(function (tenant) {
      var detail = settings.get(tenant.instanceId) || {};
      var state = tenantStatus(tenant);
      var prompt = detail.systemPrompt || (tenant.virtual ? t('whatsappSource') : t('sharedPrompt'));
      return '<tr><td><div class="restaurant-cell"><span class="restaurant-avatar">' + escapeHtml(initials(tenant.brand)) +
        '</span><span class="cell-stack"><strong>' + escapeHtml(tenant.brand || tenant.instanceId) + '</strong><small>' +
        escapeHtml(detail.domain || (tenant.virtual ? t('virtualTenant') : '—')) + '</small></span></div></td>' +
        '<td class="mono">' + escapeHtml(tenant.instanceId) + '</td><td class="mono">' + escapeHtml(detail.whatsappPhone || '—') +
        '</td><td><span class="badge ' + state.cls + '" data-live-status="' + attr(tenant.instanceId) + '">' + escapeHtml(state.label) +
        '</span></td><td><div class="prompt-preview truncate">' + escapeHtml(prompt) + '</div></td><td>' +
        escapeHtml(formatTime(detail.createdAt || tenant.createdAt)) + '</td><td class="action-cell"><button class="dots-button" type="button" data-action="menu" data-instance="' +
        attr(tenant.instanceId) + '" aria-label="' + attr(t('actions')) + '" aria-expanded="' + (openMenuId === tenant.instanceId) + '">' +
        icon('i-dots') + '</button>' + actionMenu(tenant) + '</td></tr>';
    }).join('');
  }
  function tablePanel(items, recent) {
    if (!items.length) return '<section class="panel">' + emptyState() + '</section>';
    return '<section class="panel"><div class="panel-head"><strong>' + (recent ? t('recentRestaurants') : t('restaurants')) +
      '</strong><span class="meta">' + items.length + ' ' + t('shown') + '</span><span class="spacer"></span>' +
      (recent ? addButton() : '') + '</div><div class="table-wrap"><table><thead><tr><th style="width:25%">' + t('restaurant') +
      '</th><th style="width:12%">' + t('instance') + '</th><th style="width:13%">' + t('phone') +
      '</th><th style="width:13%">' + t('status') + '</th><th style="width:25%">' + t('aiPrompt') +
      '</th><th style="width:9%">' + t('created') + '</th><th style="width:58px"></th></tr></thead><tbody>' +
      tenantRows(items) + '</tbody></table></div></section>';
  }
  function renderDashboard() {
    var c = counts();
    return '<div class="page">' + pageHeader(t('operations'), t('dashboardTitle'), t('dashboardCopy'), addButton()) +
      '<div class="stats-grid">' +
      statCard(t('restaurantCount'), c.total, t('allGateway'), 'store') +
      statCard(t('active'), c.active, t('enabledLocations'), 'power') +
      statCard(t('connected'), c.connected, t('liveSessions'), 'plug', '', 'stat-connected') +
      statCard(t('attention'), c.attention, t('requireAction'), 'alert', 'yellow', 'stat-attention') +
      '</div>' + tablePanel(filteredTenants().slice(0, 8), true) + '</div>';
  }
  function renderRestaurants() {
    var items = filteredTenants();
    return '<div class="page">' + pageHeader(t('restaurantDirectory'), t('restaurantsTitle'), t('restaurantsCopy'), addButton()) +
      '<div class="toolbar"><button class="filter ' + (activeFilter === 'all' ? 'active' : '') + '" data-filter="all">' + t('all') +
      '</button><button class="filter ' + (activeFilter === 'connected' ? 'active' : '') + '" data-filter="connected">' + t('connectedFilter') +
      '</button><button class="filter ' + (activeFilter === 'attention' ? 'active' : '') + '" data-filter="attention">' + t('attentionFilter') +
      '</button><span class="results">' + items.length + ' ' + t('results') + '</span></div>' + tablePanel(items, false) + '</div>';
  }
  function infoItem(label, value, id) {
    return '<div class="info-item"><span>' + escapeHtml(label) + '</span><strong' + (id ? ' id="' + id + '"' : '') + '>' + escapeHtml(value || '—') + '</strong></div>';
  }
  function renderDetail() {
    var tenant = report.tenants.find(function (item) { return item.instanceId === currentDetail; });
    if (!tenant) { currentDetail = ''; return renderRestaurants(); }
    var detail = settings.get(tenant.instanceId) || {};
    var live = statuses.get(tenant.instanceId) || {};
    var state = tenantStatus(tenant);
    return '<div class="page"><div class="detail-head"><button class="icon-button" type="button" data-view-link="restaurants" aria-label="' + attr(t('back')) +
      '">' + icon('back') + '</button><span class="restaurant-avatar">' + escapeHtml(initials(tenant.brand)) +
      '</span><div class="title"><h1>' + escapeHtml(tenant.brand || tenant.instanceId) + '</h1><p>' + escapeHtml(tenant.instanceId) +
      '</p></div><span class="badge ' + state.cls + '" data-live-status="' + attr(tenant.instanceId) + '">' + escapeHtml(state.label) +
      '</span><div class="header-actions"><button class="button" data-action="qr" data-instance="' + attr(tenant.instanceId) + '">' + icon('qr') +
      t('qrCode') + '</button>' + (!tenant.virtual ? '<button class="button" data-action="edit" data-instance="' + attr(tenant.instanceId) + '">' + icon('edit') + t('edit') + '</button>' : '') +
      '</div></div><div class="detail-layout"><nav class="detail-nav"><button class="active" data-section="general">' + t('general') +
      '</button><button data-section="whatsapp">' + t('whatsapp') + '</button><button data-section="prompt">' + t('prompt') +
      '</button><button data-section="health">' + t('health') + '</button><button data-section="configuration">' + t('configuration') +
      '</button></nav><div class="detail-content">' +
      '<section class="detail-section" id="section-general"><div class="detail-section-head"><strong>' + t('general') +
      '</strong></div><div class="detail-body"><div class="info-grid">' + infoItem(t('restaurantName'), tenant.brand) +
      infoItem(t('instance'), tenant.instanceId) + infoItem(t('domain'), detail.domain) + infoItem(t('address'), detail.address) +
      infoItem(t('hours'), detail.workHours) + infoItem(t('source'), tenant.virtual ? 'WhatsPro' : 'NocoDB + WhatsPro') +
      '</div></div></section>' +
      '<section class="detail-section" id="section-whatsapp"><div class="detail-section-head"><strong>WhatsApp</strong><span>' + t('realTime') +
      '</span></div><div class="detail-body"><div class="info-grid">' + infoItem(t('phone'), detail.whatsappPhone || t('noPhone')) +
      infoItem(t('liveStatus'), state.label, 'detail-live-status') + infoItem(t('lastCheck'), formatTime(lastSync)) +
      infoItem('WhatsPro', instances.some(function (item) { return String(item.instanceId || item.id) === tenant.instanceId; }) ? t('instanceExists') : t('instanceMissing')) +
      '</div><p class="confirm-copy">' + t('liveStatusCopy') + '</p></div></section>' +
      '<section class="detail-section" id="section-prompt"><div class="detail-section-head"><strong>' + t('prompt') +
      '</strong></div><div class="detail-body"><pre class="prompt-block">' + escapeHtml(detail.systemPrompt || t('sharedPrompt')) + '</pre></div></section>' +
      '<section class="detail-section" id="section-health"><div class="detail-section-head"><strong>' + t('health') +
      '</strong></div><div class="detail-body"><div class="check-list"><div class="health-check ' + (state.key === 'connected' ? '' : 'bad') +
      '"><i>' + (state.key === 'connected' ? '✓' : '!') + '</i><span>WhatsApp</span><small>' + escapeHtml(String(live.status || 'unknown')) +
      '</small></div></div></div></section>' +
      '<section class="detail-section" id="section-configuration"><div class="detail-section-head"><strong>' + t('configuration') +
      '</strong></div><div class="detail-body"><pre class="log-block">' + escapeHtml(JSON.stringify({
        instanceId: tenant.instanceId, active: tenant.active !== false, status: live.status || 'unknown',
        hasStoredSession: Boolean(live.hasStoredSession)
      }, null, 2)) + '</pre></div></section></div></div></div>';
  }
  function render() {
    updateChrome();
    $$('.nav-item[data-view]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.view === currentView && !currentDetail);
    });
    viewEl.innerHTML = currentDetail ? renderDetail() : (currentView === 'restaurants' ? renderRestaurants() : renderDashboard());
  }

  function normalizeInstances(data) {
    return Array.isArray(data) ? data : (Array.isArray(data && data.instances) ? data.instances : []);
  }
  function mergeInstances(tenantReport, liveInstances) {
    var tenantItems = Array.isArray(tenantReport && tenantReport.tenants) ? tenantReport.tenants.slice() : [];
    var known = new Set(tenantItems.map(function (item) { return String(item.instanceId); }));
    liveInstances.forEach(function (item) {
      var id = String(item.instanceId || item.id || '').trim();
      if (!id || known.has(id)) return;
      tenantItems.push({
        instanceId: id, brand: String(item.label || item.name || id), active: true,
        virtual: true, createdAt: item.createdAt || ''
      });
      known.add(id);
      settings.set(id, { domain: '', whatsappPhone: '', systemPrompt: '' });
    });
    return { tenants: tenantItems, total: tenantItems.length };
  }
  function fetchStatuses(items) {
    return Promise.all(items.map(function (tenant) {
      return api('GET', '/api/wa/status/' + encodeURIComponent(tenant.instanceId))
        .then(function (live) { statuses.set(tenant.instanceId, live || {}); })
        .catch(function () { statuses.set(tenant.instanceId, { __error: true, status: 'unavailable' }); });
    }));
  }
  function loadData(silent) {
    if (loading) return Promise.resolve();
    loading = true;
    updateChrome();
    if (!silent) $('#refresh-button').classList.add('spinning');
    return Promise.all([
      api('GET', '/api/wa/tenants').catch(function (error) {
        if (error.status === 503) return { tenants: [], total: 0, __tenantError: error };
        throw error;
      }),
      api('GET', '/api/wa/instances'),
      api('GET', '/api/wa/tenant-defaults').catch(function () { return {}; })
    ]).then(function (results) {
      instances = normalizeInstances(results[1]);
      report = mergeInstances(results[0], instances);
      defaults.domainSuffix = results[2].domainSuffix || defaults.domainSuffix;
      defaults.workHours = results[2].workHours || defaults.workHours;
      lastInstanceSignature = instances.map(function (item) { return String(item.instanceId || item.id); }).sort().join('|');
      var configRequests = report.tenants.filter(function (tenant) { return !tenant.virtual; }).map(function (tenant) {
        return api('GET', '/api/wa/tenants/' + encodeURIComponent(tenant.instanceId) + '/settings')
          .then(function (data) { settings.set(tenant.instanceId, data.tenant || {}); })
          .catch(function () { settings.set(tenant.instanceId, {}); });
      });
      return Promise.all([Promise.all(configRequests), fetchStatuses(report.tenants)]);
    }).then(function () {
      lastSync = new Date();
      render();
      if (!silent) toast(t('refreshed'), t('realTime'));
    }).catch(function (error) {
      viewEl.innerHTML = '<div class="page">' + pageHeader(t('loadFailed'), t('loadFailed'), error.message,
        '<button class="button primary" type="button" data-action="refresh">' + icon('refresh') + t('retry') + '</button>') + '</div>';
      toast(t('loadFailed'), error.message, true);
    }).finally(function () {
      loading = false;
      $('#refresh-button').classList.remove('spinning');
      updateChrome();
    });
  }
  function syncLiveStatuses() {
    if (document.hidden && !qrInstanceId) return Promise.resolve();
    return fetchStatuses(report.tenants).then(function () {
      lastSync = new Date();
      patchLiveDom();
    });
  }
  function syncInstances() {
    if (document.hidden || loading) return;
    api('GET', '/api/wa/instances').then(function (data) {
      var fresh = normalizeInstances(data);
      var signature = fresh.map(function (item) { return String(item.instanceId || item.id); }).sort().join('|');
      if (signature !== lastInstanceSignature) loadData(true);
    }).catch(function () { /* next interval retries */ });
  }

  function modalHeader(title, copy) {
    return '<div class="modal-head"><div><h2>' + escapeHtml(title) + '</h2><p>' + escapeHtml(copy || '') +
      '</p></div><button class="icon-button modal-close" type="button" data-modal-close aria-label="' + attr(t('close')) + '">' + icon('close') + '</button></div>';
  }
  function openModal(content, wide) {
    previousFocus = document.activeElement;
    modalRoot.innerHTML = '<div class="modal-backdrop"><section class="modal' + (wide ? ' wide' : '') +
      '" role="dialog" aria-modal="true">' + content + '</section></div>';
    var dialog = $('.modal', modalRoot);
    var dialogTitle = $('.modal-head h2, .action-sheet-head strong', dialog);
    if (dialogTitle) {
      dialogTitle.id = 'active-modal-title';
      dialog.setAttribute('aria-labelledby', dialogTitle.id);
    }
    document.body.style.overflow = 'hidden';
    window.setTimeout(function () {
      var target = $('[autofocus]', modalRoot) || $('button, input, textarea', modalRoot);
      if (target) target.focus();
    }, 20);
  }
  function closeModal() {
    window.clearInterval(qrTimer);
    qrTimer = 0;
    qrInstanceId = '';
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
  function openActionSheet(tenant) {
    openModal('<div class="modal-body"><div class="action-sheet"><div class="action-sheet-head"><span class="restaurant-avatar">' +
      escapeHtml(initials(tenant.brand)) + '</span><div><strong>' + escapeHtml(tenant.brand || tenant.instanceId) + '</strong><span>' +
      escapeHtml(t('menuFor')) + '</span></div></div>' + actionButtons(tenant, true) +
      '<div class="menu-rule"></div><button type="button" data-modal-close>' + icon('close') + '<span>' + t('close') + '</span></button></div></div>');
  }
  function qrStatusMarkup(instanceId, live) {
    var value = String((live && live.status) || '');
    var connected = value === 'connected';
    var qr = live && live.qr;
    return '<div class="qr-layout"><div class="qr-frame" id="qr-frame">' +
      (qr ? '<img src="' + attr(qr) + '" alt="' + attr(t('qrCode')) + '">' : '<span class="qr-placeholder">' +
      escapeHtml(connected ? t('qrConnected') : t('qrUnavailable')) + '</span>') +
      '</div><div class="qr-live-copy"><h3>' + escapeHtml(connected ? t('qrConnected') : t('qrTitle')) +
      '</h3><p>' + escapeHtml(t('qrCopy')) + '</p><div class="qr-status-line ' + (connected ? 'connected' : '') +
      '" id="qr-status"><i></i><span>' + escapeHtml(connected ? t('qrConnected') : (value === 'qr_ready' ? t('qrWaiting') : t('qrStart'))) +
      '</span></div><button class="button small" type="button" data-action="qr-refresh" data-instance="' + attr(instanceId) + '">' +
      icon('refresh') + t('refresh') + '</button></div></div>';
  }
  function refreshQrModal(instanceId) {
    if (!qrInstanceId || qrInstanceId !== instanceId || !$('#qr-live-body')) return;
    api('GET', '/api/wa/status/' + encodeURIComponent(instanceId)).then(function (live) {
      statuses.set(instanceId, live);
      var target = $('#qr-live-body');
      if (target) target.innerHTML = qrStatusMarkup(instanceId, live);
      patchLiveDom();
      if (String(live.status) === 'connected') {
        window.clearInterval(qrTimer);
        qrTimer = 0;
      }
    }).catch(function () { /* keep polling */ });
  }
  function openQrModal(instanceId) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant) return;
    qrInstanceId = instanceId;
    openModal(modalHeader(t('qrTitle'), tenant.brand || instanceId) +
      '<div class="modal-body" id="qr-live-body">' + qrStatusMarkup(instanceId, statuses.get(instanceId) || {}) +
      '</div><div class="modal-footer"><span class="spacer"></span><button class="button" type="button" data-modal-close>' + t('close') + '</button></div>', true);
    api('POST', '/api/wa/start', { instanceId: instanceId, label: tenant.brand || instanceId })
      .then(function (live) { statuses.set(instanceId, live); refreshQrModal(instanceId); })
      .catch(function (error) { toast(t('actionFailed'), error.message, true); });
    window.clearInterval(qrTimer);
    qrTimer = window.setInterval(function () { refreshQrModal(instanceId); }, 1800);
  }

  function wizardSteps(step) {
    var names = [t('nameStep'), t('phoneStep'), t('promptStep'), t('reviewStep')];
    return '<div class="steps">' + names.map(function (name, index) {
      var cls = index < step ? 'done' : (index === step ? 'active' : '');
      return '<div class="step ' + cls + '"><span class="step-index">' + (index < step ? '✓' : index + 1) +
        '</span><span>' + escapeHtml(name) + '</span></div>';
    }).join('') + '</div>';
  }
  function readWizard(form) {
    return {
      brand: String(form.brand || '').trim(), address: String(form.address || '').trim(),
      whatsappPhone: String(form.whatsappPhone || '').trim(), workHours: String(form.workHours || '').trim(),
      domain: String(form.domain || '').trim(), systemPrompt: String(form.systemPrompt || '').trim(),
      startNow: form.startNow !== false
    };
  }
  function openWizard(existing) {
    var step = 0;
    var data = existing ? {
      brand: existing.brand || '', address: existing.address || '', whatsappPhone: existing.whatsappPhone || '',
      workHours: existing.workHours || defaults.workHours, domain: existing.domain || '',
      systemPrompt: existing.systemPrompt || '', startNow: existing.startNow !== false
    } : { brand: '', address: '', whatsappPhone: '', workHours: defaults.workHours, domain: '', systemPrompt: '', startNow: true };
    var editingId = existing && existing.instanceId;
    function draw() {
      var body = '';
      if (step === 0) body = '<div class="form-grid"><div class="field full"><label>' + t('restaurantName') +
        '</label><input name="brand" aria-label="' + attr(t('restaurantName')) + '" value="' + attr(data.brand) + '" autofocus autocomplete="organization"><small>' + t('nameHint') +
        '</small></div><div class="field full"><label>' + t('address') + ' <span class="optional">(' + t('optional') +
        ')</span></label><input name="address" aria-label="' + attr(t('address')) + '" value="' + attr(data.address) + '" autocomplete="street-address"></div></div>';
      if (step === 1) body = '<div class="form-grid"><div class="field full"><label>' + t('phone') + ' <span class="optional">(' + t('optional') +
        ')</span></label><input name="whatsappPhone" aria-label="' + attr(t('phone')) + '" value="' + attr(data.whatsappPhone) + '" inputmode="tel" placeholder="+7 700 000 00 00"><small>' + t('phoneHint') +
        '</small></div><div class="field"><label>' + t('hours') + ' <span class="optional">(' + t('optional') +
        ')</span></label><input name="workHours" aria-label="' + attr(t('hours')) + '" value="' + attr(data.workHours) + '" placeholder="09:00 - 23:00"><small>' + t('hoursHint') +
        '</small></div><div class="field"><label>' + t('domain') + ' <span class="optional">(' + t('optional') +
        ')</span></label><input name="domain" aria-label="' + attr(t('domain')) + '" value="' + attr(data.domain) + '" placeholder="' + attr((slugify(data.brand) || 'restaurant') + (defaults.domainSuffix ? '.' + defaults.domainSuffix : '.kz')) +
        '"><small>' + t('domainHint') + '</small></div></div>';
      if (step === 2) body = '<div class="field"><label>' + t('systemPrompt') + ' <span class="optional">(' + t('optional') +
        ')</span></label><textarea name="systemPrompt" aria-label="' + attr(t('systemPrompt')) + '" placeholder="AI assistant…">' + escapeHtml(data.systemPrompt) +
        '</textarea><small>' + t('promptHint') + '</small></div>';
      if (step === 3) body = '<div class="review-grid">' +
        [['restaurantName', data.brand], ['instance', editingId || slugify(data.brand)], ['phone', data.whatsappPhone || '—'],
          ['hours', data.workHours || '—'], ['domain', data.domain || '—'], ['address', data.address || '—'], ['prompt', data.systemPrompt || t('sharedPrompt')]]
          .map(function (row) { return '<div class="review-row"><span>' + t(row[0]) + '</span><strong>' + escapeHtml(row[1]) + '</strong></div>'; }).join('') +
        '</div><label class="checkbox"><input type="checkbox" name="startNow" ' + (data.startNow ? 'checked' : '') + '><span>' + t('startImmediately') + '</span></label>';
      var footer = '<div class="modal-footer"><button class="button ghost" type="button" ' +
        (step ? 'data-wizard-back' : 'data-modal-close') + '>' + (step ? t('back') : t('cancel')) +
        '</button><span class="spacer"></span><button class="button primary" type="button" data-wizard-next>' +
        (step === 3 ? (editingId ? t('save') : t('createRestaurant')) : t('continue')) + '</button></div>';
      openModal(modalHeader(editingId ? t('editRestaurant') : t('newRestaurant'), t('fourSteps')) + wizardSteps(step) +
        '<div class="modal-body" data-wizard-body>' + body + '</div>' + footer);
    }
    function capture() {
      $$('input, textarea', modalRoot).forEach(function (input) {
        if (input.type === 'checkbox') data[input.name] = input.checked;
        else data[input.name] = input.value;
      });
      if (!editingId && data.brand && !data.domain && step === 1 && defaults.domainSuffix) data.domain = slugify(data.brand) + '.' + defaults.domainSuffix;
    }
    modalRoot.onclick = function (event) {
      var next = event.target.closest('[data-wizard-next]');
      var back = event.target.closest('[data-wizard-back]');
      if (back) { capture(); step -= 1; draw(); return; }
      if (!next) return;
      capture();
      if (step === 0 && !data.brand) {
        var input = $('[name="brand"]', modalRoot);
        input.closest('.field').classList.add('invalid');
        input.focus();
        toast(t('requiredField'), t('restaurantName'), true);
        return;
      }
      if (step < 3) { step += 1; draw(); return; }
      next.disabled = true;
      if (editingId) saveRestaurant(editingId, data);
      else createRestaurant(data);
    };
    draw();
  }
  function ensureInstance(instanceId, label) {
    return api('GET', '/api/wa/instances').then(function (data) {
      var found = normalizeInstances(data).some(function (item) { return String(item.instanceId || item.id) === instanceId; });
      return found ? { success: true } : api('POST', '/api/wa/instances', { instanceId: instanceId, label: label });
    });
  }
  function createRestaurant(data) {
    var generatedId = slugify(data.brand);
    var progress = 0;
    function drawProgress(error, done) {
      var steps = [t('savingRecord'), t('syncingInstance'), t('startingWhatsapp')];
      openModal(modalHeader(t('creating') + ' ' + data.brand, t('creatingCopy')) +
        '<div class="modal-body"><div class="progress-head"><strong>' + escapeHtml(done ? t('ready') : steps[Math.min(progress, 2)]) +
        '</strong><span>' + (done ? '100%' : Math.round((progress / 3) * 100) + '%') + '</span></div><div class="progress-track"><i style="width:' +
        (done ? 100 : Math.round((progress / 3) * 100)) + '%"></i></div><div class="provision-list">' +
        steps.map(function (label, index) { var state = index < progress ? 'done' : (index === progress && !done ? 'active' : ''); return '<div class="provision-step ' +
          state + '"><span class="mark">' + (index < progress || done ? '✓' : index + 1) + '</span><span>' + escapeHtml(label) + '</span></div>'; }).join('') +
        '</div>' + (error ? '<div class="failure-panel"><span class="mark">!</span><div><strong>' + t('actionFailed') + '</strong><p>' +
          escapeHtml(error.message) + '</p></div></div>' : '') + (done ? '<div class="success-panel"><span class="mark">✓</span><div><strong>' +
          t('ready') + '</strong><p>' + t('readyCopy') + '</p></div></div>' : '') + '</div><div class="modal-footer"><span class="spacer"></span>' +
        (done ? '<button class="button" data-modal-close>' + t('close') + '</button><button class="button primary" data-action="qr" data-instance="' +
          attr(generatedId) + '">' + icon('qr') + t('showQr') + '</button>' : '') + '</div>');
    }
    var payload = {
      instanceId: generatedId, brand: data.brand, whatsappPhone: data.whatsappPhone || '',
      domain: data.domain || '', address: data.address || '', workHours: data.workHours || '',
      adminPhone: data.whatsappPhone || '', promptMode: data.systemPrompt ? 'custom' : 'shared',
      systemPrompt: data.systemPrompt || '', active: true
    };
    drawProgress();
    api('POST', '/api/wa/tenants', payload).then(function (result) {
      generatedId = result.instanceId || generatedId;
      progress = 1; drawProgress();
      return ensureInstance(generatedId, data.brand);
    }).then(function () {
      progress = 2; drawProgress();
      return data.startNow ? api('POST', '/api/wa/start', { instanceId: generatedId, label: data.brand }) : {};
    }).then(function (live) {
      if (live && live.status) statuses.set(generatedId, live);
      progress = 3;
      return loadData(true);
    }).then(function () { drawProgress(null, true); })
      .catch(function (error) { drawProgress(error, false); });
  }
  function saveRestaurant(instanceId, data) {
    api('PATCH', '/api/wa/tenants/' + encodeURIComponent(instanceId), {
      brand: data.brand, whatsappPhone: data.whatsappPhone || '', domain: data.domain || '',
      address: data.address || '', workHours: data.workHours || '', adminPhone: data.whatsappPhone || '',
      promptMode: data.systemPrompt ? 'custom' : 'shared', systemPrompt: data.systemPrompt || '', active: true
    }).then(function () {
      closeModal();
      toast(t('saved'), data.brand);
      return ensureInstance(instanceId, data.brand).then(function () { return loadData(true); });
    }).catch(function (error) { toast(t('actionFailed'), error.message, true); });
  }
  function openEdit(instanceId) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant || tenant.virtual) return;
    var detail = settings.get(instanceId) || {};
    openWizard(Object.assign({}, detail, { instanceId: instanceId, brand: tenant.brand, startNow: true }));
  }
  function openDelete(instanceId) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant || tenant.virtual) return;
    openModal(modalHeader(t('deleteTitle'), t('deleteCopy')) +
      '<div class="modal-body"><p class="confirm-copy">' + t('typeInstance') + ' <strong>' + escapeHtml(instanceId) +
      '</strong></p><div class="field"><input name="confirm" aria-label="' + attr(t('instance')) + '" autocomplete="off" placeholder="' + attr(instanceId) +
      '" autofocus></div></div><div class="modal-footer"><button class="button ghost" data-modal-close>' + t('cancel') +
      '</button><span class="spacer"></span><button class="button danger" data-delete-confirm data-instance="' + attr(instanceId) +
      '" disabled>' + icon('trash') + t('deleteForever') + '</button></div>');
    $('[name="confirm"]', modalRoot).addEventListener('input', function (event) {
      $('[data-delete-confirm]', modalRoot).disabled = event.target.value !== instanceId;
    });
  }
  function runInstanceAction(instanceId, action) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant) return;
    closeModal();
    var request = action === 'restart'
      ? api('POST', '/api/wa/restart/' + encodeURIComponent(instanceId), {})
      : api('POST', '/api/wa/start', { instanceId: instanceId, label: tenant.brand || instanceId });
    request.then(function (live) {
      statuses.set(instanceId, live || {});
      patchLiveDom();
      toast(t('actionDone'), tenant.brand || instanceId);
      if (action === 'reconnect' || String(live.status) === 'qr_ready') openQrModal(instanceId);
    }).catch(function (error) { toast(t('actionFailed'), error.message, true); });
  }
  function openDetails(instanceId) {
    closeModal();
    currentDetail = instanceId;
    openMenuId = '';
    render();
    viewEl.focus({ preventScroll: true });
  }
  function changeView(name) {
    currentDetail = '';
    currentView = name || 'dashboard';
    if (currentView === 'dashboard') activeFilter = 'all';
    openMenuId = '';
    render();
    window.scrollTo({ top: 0 });
    closeMobileNav();
  }
  function closeMobileNav() {
    appShell.classList.remove('mobile-nav-open');
    $('#mobile-scrim').hidden = true;
  }

  document.addEventListener('click', function (event) {
    var nav = event.target.closest('[data-view]');
    if (nav) { changeView(nav.dataset.view); return; }
    var link = event.target.closest('[data-view-link]');
    if (link) { changeView(link.dataset.viewLink); return; }
    var action = event.target.closest('[data-action]');
    if (action) {
      var name = action.dataset.action;
      var instanceId = action.dataset.instance;
      var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
      if (name === 'new') openWizard();
      else if (name === 'refresh') loadData();
      else if (name === 'menu') {
        if (window.matchMedia('(max-width: 620px)').matches && tenant) openActionSheet(tenant);
        else { openMenuId = openMenuId === instanceId ? '' : instanceId; render(); }
      } else if (name === 'details') openDetails(instanceId);
      else if (name === 'qr') { closeModal(); window.setTimeout(function () { openQrModal(instanceId); }, 0); }
      else if (name === 'edit') { closeModal(); window.setTimeout(function () { openEdit(instanceId); }, 0); }
      else if (name === 'restart' || name === 'reconnect') runInstanceAction(instanceId, name);
      else if (name === 'delete') { closeModal(); window.setTimeout(function () { openDelete(instanceId); }, 0); }
      else if (name === 'qr-refresh') {
        api('POST', '/api/wa/start', { instanceId: instanceId, label: tenant ? tenant.brand : instanceId })
          .then(function (live) { statuses.set(instanceId, live); refreshQrModal(instanceId); })
          .catch(function (error) { toast(t('actionFailed'), error.message, true); });
      }
      return;
    }
    var filter = event.target.closest('[data-filter]');
    if (filter) { activeFilter = filter.dataset.filter; render(); return; }
    var sectionButton = event.target.closest('[data-section]');
    if (sectionButton) {
      $$('.detail-nav button').forEach(function (button) { button.classList.toggle('active', button === sectionButton); });
      var section = $('#section-' + sectionButton.dataset.section);
      if (section) section.scrollIntoView({ block: 'start' });
      return;
    }
    var close = event.target.closest('[data-modal-close]');
    if (close) { closeModal(); return; }
    var deleteConfirm = event.target.closest('[data-delete-confirm]');
    if (deleteConfirm) {
      var deleteId = deleteConfirm.dataset.instance;
      deleteConfirm.disabled = true;
      api('DELETE', '/api/wa/tenants/' + encodeURIComponent(deleteId), { confirm: deleteId }).then(function () {
        closeModal();
        toast(t('deleted'), deleteId);
        return loadData(true);
      }).catch(function (error) { deleteConfirm.disabled = false; toast(t('actionFailed'), error.message, true); });
      return;
    }
    if (!event.target.closest('.action-menu') && !event.target.closest('[data-action="menu"]') && openMenuId) {
      openMenuId = '';
      render();
    }
  });
  modalRoot.addEventListener('click', function (event) {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); searchEl.focus(); return;
    }
    if (event.key === 'Escape') {
      if (modalRoot.innerHTML) closeModal();
      else { openMenuId = ''; $('#locale-menu').hidden = true; $('#profile-menu').hidden = true; closeMobileNav(); render(); }
      return;
    }
    if (event.key === 'Tab' && modalRoot.innerHTML) {
      var focusable = $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', modalRoot);
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  searchEl.addEventListener('input', function (event) { searchQuery = event.target.value; render(); });
  $('#focus-mode').addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
  $('#locale-button').addEventListener('click', function (event) {
    event.stopPropagation();
    var menu = $('#locale-menu');
    menu.hidden = !menu.hidden;
    $('#locale-button').setAttribute('aria-expanded', String(!menu.hidden));
    $('#profile-menu').hidden = true;
  });
  $('#locale-menu').addEventListener('click', function (event) {
    var button = event.target.closest('[data-locale]');
    if (!button) return;
    locale = button.dataset.locale === 'ru' ? 'ru' : 'kk';
    localStorage.setItem('whatspro_locale', locale);
    $('#locale-menu').hidden = true;
    $('#locale-button').setAttribute('aria-expanded', 'false');
    applyStaticTranslations();
    render();
  });
  $('#profile-button').addEventListener('click', function (event) {
    event.stopPropagation();
    var menu = $('#profile-menu');
    menu.hidden = !menu.hidden;
    $('#profile-button').setAttribute('aria-expanded', String(!menu.hidden));
    $('#locale-menu').hidden = true;
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest('.profile-wrap')) { $('#profile-menu').hidden = true; $('#profile-button').setAttribute('aria-expanded', 'false'); }
    if (!event.target.closest('.locale-wrap')) { $('#locale-menu').hidden = true; $('#locale-button').setAttribute('aria-expanded', 'false'); }
  });
  $('#profile-menu').addEventListener('click', function (event) {
    var action = event.target.closest('[data-profile-action]');
    if (!action) return;
    if (action.dataset.profileAction === 'refresh') loadData();
    if (action.dataset.profileAction === 'logout') {
      api('POST', '/api/whatspro/logout', {}).then(function () { window.location.href = '/'; })
        .catch(function (error) { toast(t('signOutFailed'), error.message, true); });
    }
  });
  $('#refresh-button').addEventListener('click', function () { loadData(); });
  $('#sidebar-toggle').addEventListener('click', function () { appShell.classList.toggle('collapsed'); });
  $('#mobile-menu').addEventListener('click', function () {
    appShell.classList.add('mobile-nav-open');
    $('#mobile-scrim').hidden = false;
  });
  $('#mobile-scrim').addEventListener('click', closeMobileNav);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) syncLiveStatuses(); });

  applyStaticTranslations();
  loadData(true);
  statusTimer = window.setInterval(syncLiveStatuses, 5000);
  instanceTimer = window.setInterval(syncInstances, 15000);
  window.setInterval(updateChrome, 10000);
}());
