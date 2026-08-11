(function () {
  'use strict';

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var $$ = function (selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); };
  var viewEl = $('#view');
  var modalRoot = $('#modal-root');
  var appShell = $('#app-shell');
  var loginShell = $('#login-shell');
  var loginForm = $('#login-form');
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
  var statusSyncing = false;
  var lastSync = null;
  var lastInstanceSignature = '';
  var statusTimer = 0;
  var instanceTimer = 0;
  var qrTimer = 0;
  var qrInstanceId = '';
  var qrShareLinks = new Map();
  var previousFocus = null;
  var appStarted = false;
  var authUsername = '';
  var defaults = { domainSuffix: '', workHours: '09:00 - 03:00' };
  var locale = localStorage.getItem('whatspro_locale') === 'ru' ? 'ru' : 'kk';
  var theme = localStorage.getItem('whatspro_theme') === 'light' ? 'light' : 'dark';

  var ICONS = {
    plus: 'i-plus', store: 'i-store', power: 'i-power', plug: 'i-plug', clock: 'i-clock',
    eye: 'i-eye', edit: 'i-edit', restart: 'i-restart', link: 'i-link', qr: 'i-qr',
    trash: 'i-trash', check: 'i-check', close: 'i-close', alert: 'i-alert',
    back: 'i-arrow-left', refresh: 'i-refresh', copy: 'i-copy', spark: 'i-spark',
    download: 'i-download', upload: 'i-upload'
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
      duplicate: 'Дубликат жасау', duplicateSuffix: 'көшірмесі', duplicateRestaurant: 'Ресторанды дубликаттау',
      restart: 'Қайта іске қосу', reconnect: 'Қайта қосу', qrCode: 'QR код', delete: 'Өшіру',
      general: 'Жалпы', whatsapp: 'WhatsApp', prompt: 'Промпт', health: 'Күй',
      configuration: 'Конфигурация', back: 'Артқа', address: 'Мекенжай', hours: 'Жұмыс уақыты',
      domain: 'Домен', source: 'Дереккөзі', lastCheck: 'Соңғы тексеру', liveStatus: 'Нақты күй',
      alemiApiUrl: 'Alemi API мекенжайы', alemiInstance: 'Alemi instance', alemiSecret: 'Alemi API кілті',
      alemiSecretHint: 'Кілт тек сақтауға жіберіледі; кейін экранда қайта көрсетілмейді. Сол мәнді hub.alemi.kz-тегі ресторанның Secret Key өрісіне қойыңыз.',
      alemiSecretStored: 'Кілт сақталған', alemiSecretMissing: 'Кілт енгізілмеген', alemiSecretWillUpdate: 'Жаңа кілт сақталады',
      generateSecret: 'Генерациялау', copySecret: 'Көшіру', secretCopied: 'Кілт көшірілді',
      secretGenerated: 'Кілт жасалды — көшіріп, hub.alemi.kz-ке қойыңыз',
      secretEmptyToCopy: 'Алдымен кілт жасаңыз немесе енгізіңіз',
      secretGenerateFailed: 'Браузер қауіпсіз кездейсоқ сан бере алмады',
      rotateAlemiSecret: 'Alemi кілтін жаңарту', rotateAlemiSecretTitle: 'Alemi API кілтін орнату немесе ауыстыру',
      rotateAlemiSecretCopy: 'Жаңа кілтті енгізіңіз. Қауіпсіздік үшін ағымдағы мән көрсетілмейді.', secretUpdated: 'Alemi кілті жаңартылды',
      liveStatusCopy: 'Бұл күй WhatsPro сессиясынан тікелей алынды.',
      qrTitle: 'WhatsApp-ты байланыстыру', qrCopy: 'Телефоныңызда WhatsApp → Байланыстырылған құрылғылар → Құрылғыны байланыстыру бөлімін ашып, осы кодты сканерлеңіз.',
      qrWaiting: 'QR дайын — телефонмен сканерлеңіз', qrConnected: 'WhatsApp сәтті қосылды', qrStart: 'Сессия іске қосылуда…',
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
      loginEyebrow: 'ҚАУІПСІЗ КІРУ', loginTitle: 'Әкімші панеліне кіру',
      loginDescription: 'Ресторандар мен WhatsApp сессияларын басқару үшін Environment ішінде сақталған деректермен кіріңіз.',
      login: 'Логин', password: 'Құпиясөз', rememberLogin: 'Логин мен сессияны сақтау',
      signIn: 'Кіру', signingIn: 'Кіру орындалуда…', protectedWorkspace: 'Қорғалған әкімші кеңістігі',
      invalidCredentials: 'Логин немесе құпиясөз дұрыс емес.', loginNotConfigured: 'Dokploy Environment ішінде WHATSPRO_USER және WHATSPRO_PASSWORD бапталмаған.',
      loginRequired: 'Логин мен құпиясөзді толтырыңыз.', copyInstance: 'Instance ID көшіру',
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
      duplicate: 'Дублировать', duplicateSuffix: 'копия', duplicateRestaurant: 'Дублировать ресторан',
      restart: 'Перезапустить', reconnect: 'Подключить заново', qrCode: 'QR-код', delete: 'Удалить',
      general: 'Общее', whatsapp: 'WhatsApp', prompt: 'Промпт', health: 'Состояние',
      configuration: 'Конфигурация', back: 'Назад', address: 'Адрес', hours: 'Часы работы',
      domain: 'Домен', source: 'Источник', lastCheck: 'Последняя проверка', liveStatus: 'Фактический статус',
      alemiApiUrl: 'Адрес Alemi API', alemiInstance: 'Alemi instance', alemiSecret: 'Ключ Alemi API',
      alemiSecretHint: 'Ключ отправляется только на сохранение и больше не показывается на экране. Это же значение впишите в поле Secret Key ресторана на hub.alemi.kz.',
      alemiSecretStored: 'Ключ сохранён', alemiSecretMissing: 'Ключ не задан', alemiSecretWillUpdate: 'Будет сохранён новый ключ',
      generateSecret: 'Сгенерировать', copySecret: 'Скопировать', secretCopied: 'Ключ скопирован',
      secretGenerated: 'Ключ создан — скопируйте и впишите на hub.alemi.kz',
      secretEmptyToCopy: 'Сначала создайте или введите ключ',
      secretGenerateFailed: 'Браузер не смог выдать безопасное случайное число',
      rotateAlemiSecret: 'Обновить ключ Alemi', rotateAlemiSecretTitle: 'Задать или заменить ключ Alemi API',
      rotateAlemiSecretCopy: 'Введите новый ключ. Текущее значение не показывается из соображений безопасности.', secretUpdated: 'Ключ Alemi обновлён',
      liveStatusCopy: 'Этот статус получен напрямую из сессии WhatsPro.',
      qrTitle: 'Подключить WhatsApp', qrCopy: 'Откройте WhatsApp → Связанные устройства → Привязка устройства и отсканируйте этот код.',
      qrWaiting: 'QR готов — отсканируйте телефоном', qrConnected: 'WhatsApp успешно подключён', qrStart: 'Сессия запускается…',
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
      loginEyebrow: 'БЕЗОПАСНЫЙ ВХОД', loginTitle: 'Вход в панель администратора',
      loginDescription: 'Войдите с данными из Environment, чтобы управлять ресторанами и WhatsApp-сессиями.',
      login: 'Логин', password: 'Пароль', rememberLogin: 'Сохранить логин и сессию',
      signIn: 'Войти', signingIn: 'Вход…', protectedWorkspace: 'Защищённое пространство администратора',
      invalidCredentials: 'Неверный логин или пароль.', loginNotConfigured: 'В Dokploy Environment не настроены WHATSPRO_USER и WHATSPRO_PASSWORD.',
      loginRequired: 'Введите логин и пароль.', copyInstance: 'Скопировать Instance ID',
      instanceExists: 'Instance есть в списке WhatsPro', instanceMissing: 'Instance отсутствует в WhatsPro',
      statusConnected: 'connected', statusQr: 'qr_ready', statusOffline: 'offline'
    }
  };

  // Product language stays universal: a tenant can be a shop, fast-food
  // location, service point, or restaurant. Backend field names remain stable.
  Object.assign(I18N.kk, {
    documentTitle: 'WhatsPro — Нысандарды басқару',
    restaurants: 'Нысандар',
    platform: 'Бизнес платформасы',
    searchPlaceholder: 'Нысан, instance немесе телефон іздеу…',
    dashboardCopy: 'Барлық нысанның WhatsApp байланысы мен бот күйін бір жерден бақылаңыз.',
    addRestaurant: 'Қосу',
    restaurantCount: 'Нысандар',
    enabledLocations: 'Боты қосылған нысандар',
    recentRestaurants: 'Барлығы',
    allEntities: 'Барлығы',
    restaurant: 'Нысан',
    noRestaurants: 'Нысандар әлі жоқ',
    noRestaurantsCopy: 'Алғашқы нысанды қосып, WhatsApp сессиясын байланыстырыңыз.',
    restaurantDirectory: 'НЫСАНДАР ТІЗІМІ',
    restaurantsTitle: 'Нысандар',
    restaurantsCopy: 'Нысандарды, олардың WhatsApp байланысын және бот күйін басқарыңыз.',
    duplicateRestaurant: 'Нысанды дубликаттау',
    newRestaurant: 'Жаңа нысан',
    restaurantName: 'Нысан атауы',
    createRestaurant: 'Нысанды құру',
    creatingCopy: 'Нысан мен WhatsPro сессиясы бірге дайындалады.',
    savingRecord: 'Нысан деректері сақталуда',
    readyCopy: 'Нысан құрылды. WhatsApp қосу үшін QR кодты сканерлеңіз немесе сілтемені клиентке жіберіңіз.',
    editRestaurant: 'Нысанды өзгерту',
    deleteTitle: 'Нысанды өшіру',
    deleteCopy: 'Нысан деректері мен WhatsApp сессиясы біржола өшіріледі.',
    deleted: 'Нысан өшірілді',
    menuFor: 'Нысан әрекеттері',
    loginDescription: 'Нысандарды, WhatsApp сессияларын және боттарды басқару үшін кіріңіз.',
    pauseBot: 'Ботты тоқтату',
    resumeBot: 'Ботты қосу',
    botPaused: 'Бот тоқтатылды',
    botResumed: 'Бот іске қосылды',
    calls: 'Қоңырау',
    disableCalls: 'Қоңырауды өшіру',
    enableCalls: 'Қоңырауды қосу',
    callsDisabledMsg: 'Қоңырау өшіріп қойылды',
    callsEnabledMsg: 'Қоңырау қосылды',
    botState: 'Бот',
    botEnabled: 'Жұмыс істеп тұр',
    shareQr: 'Сілтемемен бөлісу',
    copyLink: 'Сілтемені көшіру',
    shareTitle: 'WhatsApp-ты қосу',
    shareText: 'Сілтемені ашып, QR кодты телефонмен сканерлеңіз. Бір код хабарламаларға да, қоңырауларға да жарайды: клиент звандағанда бот қоңырауды бір секундта басып тастап, оған бірден жауап хабарламасын жібереді.',
    linkCopied: 'Қосылу сілтемесі көшірілді',
    linkExpires: 'Сілтеме 72 сағат жарамды',
    exportExcel: 'Excel-ге сақтау',
    exportAllExcel: 'Барлығын Excel-ге экспорттау',
    importExcel: 'Excel-ден қалпына келтіру',
    importTitle: 'Резервті қалпына келтіру',
    importCopy: 'Файлдағы нысандар instance ID бойынша қосылады немесе жаңартылады. Басқа нысандар өшірілмейді.',
    importConfirm: 'Импорттау',
    importDone: 'Резерв қалпына келтірілді',
    importSummary: 'Импортталды: {imported}, жаңа: {created}, жаңартылды: {updated}',
    invalidExcel: 'WhatsPro жасаған .xlsx резервтік файлын таңдаңыз.',
    sensitiveBackup: 'Кілттер экспортталмайды. Жаңа нысандардың кілттері импорт кезінде автоматты жасалады.'
  });
  Object.assign(I18N.ru, {
    documentTitle: 'WhatsPro — Управление точками',
    restaurants: 'Точки',
    platform: 'Бизнес-платформа',
    searchPlaceholder: 'Поиск по точке, instance или телефону…',
    dashboardCopy: 'Контролируйте WhatsApp-подключения и состояние ботов всех точек в одном месте.',
    addRestaurant: 'Добавить',
    restaurantCount: 'Точки',
    enabledLocations: 'Точки с включённым ботом',
    recentRestaurants: 'Все',
    allEntities: 'Все',
    restaurant: 'Точка',
    noRestaurants: 'Точек пока нет',
    noRestaurantsCopy: 'Добавьте первую точку и подключите WhatsApp-сессию.',
    restaurantDirectory: 'СПИСОК ТОЧЕК',
    restaurantsTitle: 'Точки',
    restaurantsCopy: 'Управляйте точками, их WhatsApp-подключениями и состоянием бота.',
    duplicateRestaurant: 'Дублировать точку',
    newRestaurant: 'Новая точка',
    restaurantName: 'Название точки',
    createRestaurant: 'Создать точку',
    creatingCopy: 'Точка и сессия WhatsPro подготавливаются вместе.',
    savingRecord: 'Сохраняются данные точки',
    readyCopy: 'Точка создана. Отсканируйте QR-код или отправьте клиенту ссылку для подключения.',
    editRestaurant: 'Изменить точку',
    deleteTitle: 'Удалить точку',
    deleteCopy: 'Данные точки и WhatsApp-сессия будут удалены безвозвратно.',
    deleted: 'Точка удалена',
    menuFor: 'Действия точки',
    loginDescription: 'Войдите, чтобы управлять точками, WhatsApp-сессиями и ботами.',
    pauseBot: 'Остановить бота',
    resumeBot: 'Включить бота',
    botPaused: 'Бот остановлен',
    botResumed: 'Бот включён',
    calls: 'Звонки',
    disableCalls: 'Отключить звонки',
    enableCalls: 'Включить звонки',
    callsDisabledMsg: 'Звонки отключены',
    callsEnabledMsg: 'Звонки включены',
    botState: 'Бот',
    botEnabled: 'Работает',
    shareQr: 'Поделиться ссылкой',
    copyLink: 'Скопировать ссылку',
    shareTitle: 'Подключение WhatsApp',
    shareText: 'Откройте ссылку и отсканируйте QR-код телефоном. Один код подключает и сообщения, и звонки: бот сбрасывает входящий звонок за секунду и сразу отправляет клиенту сообщение.',
    linkCopied: 'Ссылка подключения скопирована',
    linkExpires: 'Ссылка действует 72 часа',
    exportExcel: 'Сохранить в Excel',
    exportAllExcel: 'Экспортировать всё в Excel',
    importExcel: 'Восстановить из Excel',
    importTitle: 'Восстановление резервной копии',
    importCopy: 'Точки из файла будут созданы или обновлены по instance ID. Остальные точки не удаляются.',
    importConfirm: 'Импортировать',
    importDone: 'Резервная копия восстановлена',
    importSummary: 'Импортировано: {imported}, новых: {created}, обновлено: {updated}',
    invalidExcel: 'Выберите резервный .xlsx-файл, созданный WhatsPro.',
    sensitiveBackup: 'Ключи не экспортируются. Для новых точек они создаются автоматически при импорте.'
  });

  function t(key) { return (I18N[locale] && I18N[locale][key]) || key; }
  function tf(key, values) {
    return Object.keys(values || {}).reduce(function (text, name) {
      return text.replace(new RegExp('\\{' + name + '\\}', 'g'), String(values[name]));
    }, t(key));
  }
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
          requestError.code = data.error || '';
          requestError.status = response.status;
          if (response.status === 401 && path !== '/api/platform/login' && path !== '/api/platform/session') showLogin();
          throw requestError;
        }
        return data;
      });
    });
  }
  function setLoginError(message) {
    var error = $('#login-error');
    error.textContent = message || '';
    error.hidden = !message;
    $('#login-username').setAttribute('aria-invalid', message ? 'true' : 'false');
    $('#login-password').setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) {
      $('#login-username').setAttribute('aria-describedby', 'login-error');
      $('#login-password').setAttribute('aria-describedby', 'login-error');
    } else {
      $('#login-username').removeAttribute('aria-describedby');
      $('#login-password').removeAttribute('aria-describedby');
    }
  }
  function stopAppTimers() {
    window.clearInterval(statusTimer);
    window.clearInterval(instanceTimer);
    statusTimer = 0;
    instanceTimer = 0;
  }
  function showLogin() {
    stopAppTimers();
    appShell.hidden = true;
    loginShell.hidden = false;
    var remembered = localStorage.getItem('platform_remember_login') === '1' ||
      localStorage.getItem('whatspro_remember_login') === '1';
    $('#login-remember').checked = remembered;
    $('#login-username').value = remembered
      ? (localStorage.getItem('platform_login_username') || localStorage.getItem('whatspro_login_username') || '')
      : '';
    $('#login-password').value = '';
    syncLoginInputState($('#login-username'));
    syncLoginInputState($('#login-password'));
    window.setTimeout(function () { (remembered ? $('#login-password') : $('#login-username')).focus(); }, 0);
  }
  function startApp(username) {
    authUsername = String(username || t('admin'));
    loginShell.hidden = true;
    appShell.hidden = false;
    setLoginError('');
    $('#profile-name').textContent = authUsername;
    if (!appStarted) {
      appStarted = true;
      statusTimer = window.setInterval(syncLiveStatuses, 5000);
      instanceTimer = window.setInterval(syncInstances, 15000);
    } else {
      if (!statusTimer) statusTimer = window.setInterval(syncLiveStatuses, 5000);
      if (!instanceTimer) instanceTimer = window.setInterval(syncInstances, 15000);
    }
    return loadData(true);
  }
  function checkSession() {
    return api('GET', '/api/platform/session').then(function (session) {
      return startApp(session.username);
    }).catch(function (error) {
      if (error.status !== 401) setLoginError(error.message);
      showLogin();
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
  function copyText(value, options) {
    var text = String(value || '');
    var opts = options || {};
    var write = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : new Promise(function (resolve, reject) {
        var input = document.createElement('textarea');
        input.value = text;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        try {
          if (!document.execCommand('copy')) throw new Error('COPY_FAILED');
          resolve();
        } catch (error) { reject(error); }
        finally { input.remove(); }
      });
    return write.then(function () {
      toast(opts.title || t('copyDone'), opts.secret ? '' : text);
    });
  }

  function generateNumericSecret(length) {
    var size = length || 12;
    var source = window.crypto || window.msCrypto;
    if (!source || typeof source.getRandomValues !== 'function') return '';
    var digits = '';
    var buffer = new Uint8Array(size * 2);
    while (digits.length < size) {
      source.getRandomValues(buffer);
      for (var i = 0; i < buffer.length && digits.length < size; i += 1) {
        // Rejection sampling: 250..255 would bias the modulo, so drop those bytes.
        if (buffer[i] < 250) digits += String(buffer[i] % 10);
      }
    }
    return digits;
  }

  function secretActions(inputId) {
    return '<button class="button ghost small" type="button" data-generate-secret="' + attr(inputId) + '">' +
      icon('refresh') + '<span>' + escapeHtml(t('generateSecret')) + '</span></button>' +
      '<button class="button ghost small" type="button" data-copy-input="' + attr(inputId) + '">' +
      icon('copy') + '<span>' + escapeHtml(t('copySecret')) + '</span></button>';
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
    $('#locale-button').title = t('changeLanguage');
    $('#locale-button span').textContent = locale === 'ru' ? 'РУС' : 'ҚАЗ';
    $('#profile-name').textContent = authUsername || t('admin');
    $('#profile-role').textContent = t('owner');
    $('#profile-workspace').textContent = t('adminPanel');
    $('#profile-session').textContent = t('secureSession');
    $('#profile-refresh').textContent = t('refreshData');
    $('#profile-export').textContent = t('exportAllExcel');
    $('#profile-import').textContent = t('importExcel');
    $('#profile-logout').textContent = t('logout');
    $('#refresh-button').setAttribute('aria-label', t('refresh'));
    $('#login-platform-label').textContent = t('platform');
    $('#login-eyebrow').textContent = t('loginEyebrow');
    $('#login-title').textContent = t('loginTitle');
    $('#login-description').textContent = t('loginDescription');
    $('#login-username-label').textContent = t('login');
    $('#login-password-label').textContent = t('password');
    $('#login-remember-label').textContent = t('rememberLogin');
    $('#login-submit-label').textContent = t('signIn');
    $('#login-foot-label').textContent = t('protectedWorkspace');
    applyTheme();
  }

  function tenantStatus(tenant) {
    if (tenant.botEnabled === false) return { label: t('paused'), cls: 'neutral', key: 'paused' };
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
      active: report.tenants.filter(function (item) { return item.botEnabled !== false; }).length,
      connected: report.tenants.filter(function (item) {
        return String((statuses.get(item.instanceId) || {}).status || '').toLowerCase() === 'connected';
      }).length,
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
    if (!tenant.virtual) html += '<button type="button" data-action="edit" data-instance="' + attr(tenant.instanceId) + '">' + icon('edit') + '<span>' + t('edit') + '</span></button>' +
      '<button type="button" data-action="alemi-secret" data-instance="' + attr(tenant.instanceId) + '">' + icon('link') + '<span>' + t('rotateAlemiSecret') + '</span></button>' +
      '<button type="button" data-action="duplicate" data-instance="' + attr(tenant.instanceId) + '">' + icon('copy') + '<span>' + t('duplicate') + '</span></button>' +
      '<button type="button" data-action="export-excel" data-instance="' + attr(tenant.instanceId) + '">' + icon('download') + '<span>' + t('exportExcel') + '</span></button>' +
      '<button type="button" data-action="bot-toggle" data-instance="' + attr(tenant.instanceId) + '" data-enabled="' + (tenant.botEnabled === false ? 'true' : 'false') + '">' +
      icon('power') + '<span>' + t(tenant.botEnabled === false ? 'resumeBot' : 'pauseBot') + '</span></button>' +
      '<button type="button" class="calls-toggle-btn" data-action="calls-toggle" data-instance="' + attr(tenant.instanceId) + '" data-disabled="' + (tenant.callsDisabled === false ? 'true' : 'false') + '">' +
      '<span class="toggle-pill ' + (tenant.callsDisabled === false ? 'on' : '') + '"></span>' +
      '<span>' + t('calls') + '</span></button>';
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
    return '<section class="panel"><div class="panel-head"><strong>' + (recent ? t('allEntities') : t('restaurants')) +
      '</strong><span class="count-pill" aria-label="' + attr(items.length + ' ' + t('shown')) + '">' + items.length + '</span><span class="spacer"></span>' +
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
  function alemiSecretItem(instanceId, stored) {
    return '<div class="info-item secret-item"><span>' + escapeHtml(t('alemiSecret')) + '</span>' +
      '<div class="secret-row"><input id="detail-alemi-secret" name="alemiSecret" type="text" autocomplete="off" ' +
      'placeholder="' + attr(stored ? t('alemiSecretStored') : t('alemiSecretMissing')) + '">' +
      secretActions('detail-alemi-secret') +
      '<button class="button primary small" type="button" data-save-alemi-secret data-instance="' + attr(instanceId) +
      '" data-secret-input="detail-alemi-secret">' + escapeHtml(t('save')) + '</button></div>' +
      '<small>' + escapeHtml(t('alemiSecretHint')) + '</small></div>';
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
      infoItem(t('hours'), detail.workHours) + infoItem(t('alemiApiUrl'), detail.alemiApiUrl) +
      infoItem(t('alemiInstance'), detail.alemiInstance) +
      (tenant.virtual ? infoItem(t('alemiSecret'), detail.secrets && detail.secrets.alemiSecret ? t('alemiSecretStored') : t('alemiSecretMissing'))
        : alemiSecretItem(tenant.instanceId, Boolean(detail.secrets && detail.secrets.alemiSecret))) +
      infoItem(t('source'), 'WhatsPro Platform') +
      '</div></div></section>' +
      '<section class="detail-section" id="section-whatsapp"><div class="detail-section-head"><strong>WhatsApp</strong><span>' + t('realTime') +
      '</span></div><div class="detail-body"><div class="info-grid">' + infoItem(t('phone'), detail.whatsappPhone || t('noPhone')) +
      infoItem(t('liveStatus'), state.label, 'detail-live-status') + infoItem(t('botState'), tenant.botEnabled === false ? t('paused') : t('botEnabled')) +
      infoItem(t('lastCheck'), formatTime(lastSync)) +
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
        instanceId: tenant.instanceId, active: tenant.active !== false, botEnabled: tenant.botEnabled !== false, status: live.status || 'unknown',
        hasStoredSession: Boolean(live.hasStoredSession), alemiApiUrl: detail.alemiApiUrl || '',
        alemiInstance: detail.alemiInstance || '',
        alemiLinked: Boolean(detail.alemiLinked),
        alemiSecretSet: Boolean(detail.secrets && detail.secrets.alemiSecret)
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
    var instanceIds = items.map(function (tenant) { return tenant.instanceId; });
    if (!instanceIds.length) return Promise.resolve();
    return api('POST', '/api/wa/statuses', { instanceIds: instanceIds }).then(function (data) {
      var liveStatuses = data.statuses || {};
      instanceIds.forEach(function (instanceId) {
        statuses.set(instanceId, liveStatuses[instanceId] || { __error: true, status: 'unavailable' });
      });
    }).catch(function () {
      instanceIds.forEach(function (instanceId) {
        statuses.set(instanceId, { __error: true, status: 'unavailable' });
      });
    });
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
    if ((document.hidden && !qrInstanceId) || loading || statusSyncing) return Promise.resolve();
    statusSyncing = true;
    return fetchStatuses(report.tenants).then(function () {
      lastSync = new Date();
      patchLiveDom();
    }).finally(function () { statusSyncing = false; });
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
  function labelDialog(dialog) {
    var dialogTitle = $('.modal-head h2, .action-sheet-head strong', dialog);
    if (dialogTitle) {
      dialogTitle.id = 'active-modal-title';
      dialog.setAttribute('aria-labelledby', dialogTitle.id);
    }
  }
  function openModal(content, wide, variant) {
    previousFocus = document.activeElement;
    modalRoot.innerHTML = '<div class="modal-backdrop"><section class="modal' + (wide ? ' wide' : '') +
      (variant ? ' ' + variant : '') + '" role="dialog" aria-modal="true">' + content + '</section></div>';
    var dialog = $('.modal', modalRoot);
    labelDialog(dialog);
    document.body.style.overflow = 'hidden';
    window.setTimeout(function () {
      var target = $('[autofocus]', modalRoot) || $('button, input, textarea', modalRoot);
      if (target) target.focus();
    }, 20);
  }
  function replaceModal(content, wide) {
    var dialog = $('.modal', modalRoot);
    if (!dialog) return openModal(content, wide);
    dialog.classList.toggle('wide', Boolean(wide));
    dialog.innerHTML = content;
    labelDialog(dialog);
  }
  function closeModal() {
    window.clearInterval(qrTimer);
    qrTimer = 0;
    qrInstanceId = '';
    pendingImportFile = null;
    // Wizard state may hold a just-entered write-only key. Drop its event
    // closure as soon as the modal closes so it cannot linger in page state.
    modalRoot.onclick = null;
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
    if (previousFocus && document.contains(previousFocus)) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
  function openActionSheet(tenant) {
    openModal('<div class="modal-body"><div class="action-sheet"><div class="action-sheet-head"><span class="restaurant-avatar">' +
      escapeHtml(initials(tenant.brand)) + '</span><div><strong>' + escapeHtml(tenant.brand || tenant.instanceId) + '</strong><span>' +
      escapeHtml(t('menuFor')) + '</span></div></div>' + actionButtons(tenant, true) +
      '<div class="menu-rule"></div><button type="button" data-modal-close>' + icon('close') + '<span>' + t('close') + '</span></button></div></div>', false, 'sheet');
  }
  function qrStatusMarkup(instanceId, live) {
    var value = String((live && live.status) || '');
    var connected = value === 'connected';
    var qr = live && live.qr;
    var shareUrl = qrShareLinks.get(instanceId) || '';
    return '<div class="qr-layout"><div class="qr-frame" id="qr-frame">' +
      (qr ? '<img src="' + attr(qr) + '" alt="' + attr(t('qrCode')) + '">' : '<span class="qr-placeholder">' +
      escapeHtml(connected ? t('qrConnected') : t('qrUnavailable')) + '</span>') +
      '</div><div class="qr-live-copy"><h3>' + escapeHtml(connected ? t('qrConnected') : t('qrTitle')) +
      '</h3><p>' + escapeHtml(t('qrCopy')) + '</p><div class="qr-status-line ' + (connected ? 'connected' : '') +
      '" id="qr-status"><i></i><span>' + escapeHtml(connected ? t('qrConnected') : (value === 'qr_ready' ? t('qrWaiting') : t('qrStart'))) +
      '</span></div><div class="qr-share-actions"><button class="button small" type="button" data-action="qr-refresh" data-instance="' + attr(instanceId) + '">' +
      icon('refresh') + t('refresh') + '</button><button class="button small primary" type="button" data-action="qr-share" data-instance="' +
      attr(instanceId) + '">' + icon('link') + t('shareQr') + '</button>' +
      (shareUrl ? '<button class="button small" type="button" data-copy-value="' + attr(shareUrl) + '">' + icon('copy') + t('copyLink') + '</button>' : '') +
      '</div><small class="share-expiry">' + t('linkExpires') + '</small></div></div>';
  }

  function shareQrLink(instanceId) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    var existing = qrShareLinks.get(instanceId);
    var request = existing
      ? Promise.resolve(existing)
      : api('POST', '/api/wa/tenants/' + encodeURIComponent(instanceId) + '/connect-link', { locale: locale })
        .then(function (result) {
          qrShareLinks.set(instanceId, result.url);
          var target = $('#qr-live-body');
          if (target) target.innerHTML = qrStatusMarkup(instanceId, statuses.get(instanceId) || {});
          return result.url;
        });
    return request.then(function (url) {
      if (navigator.share) {
        return navigator.share({
          title: t('shareTitle') + (tenant ? ' — ' + tenant.brand : ''),
          text: t('shareText'),
          url: url
        }).catch(function (error) {
          if (error && error.name === 'AbortError') return;
          return copyText(url).then(function () { toast(t('linkCopied'), tenant ? tenant.brand : instanceId); });
        });
      }
      return copyText(url).then(function () { toast(t('linkCopied'), tenant ? tenant.brand : instanceId); });
    });
  }

  function exportWorkbook(instanceId) {
    var query = instanceId ? '?instanceId=' + encodeURIComponent(instanceId) : '';
    var link = document.createElement('a');
    link.href = '/api/wa/backups/tenants.xlsx' + query;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast(instanceId ? t('exportExcel') : t('exportAllExcel'), t('sensitiveBackup'));
  }

  var pendingImportFile = null;
  function openImportModal(file) {
    pendingImportFile = file;
    openModal(modalHeader(t('importTitle'), t('importCopy')) +
      '<div class="modal-body"><div class="backup-file-card">' + icon('upload') +
      '<div><strong>' + escapeHtml(file.name) + '</strong><span>' +
      escapeHtml(Math.max(1, Math.ceil(file.size / 1024)) + ' KB') +
      '</span></div></div><p class="confirm-copy backup-warning">' + escapeHtml(t('sensitiveBackup')) +
      '</p></div><div class="modal-footer"><button class="button" type="button" data-modal-close>' + t('cancel') +
      '</button><span class="spacer"></span><button class="button primary" type="button" data-import-confirm>' +
      icon('upload') + t('importConfirm') + '</button></div>');
  }

  function importWorkbook(file, button) {
    button.disabled = true;
    return fetch('/api/wa/backups/tenants/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: file
    }).then(function (response) {
      return response.text().then(function (raw) {
        var data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (error) { data = {}; }
        if (!response.ok) {
          if (response.status === 401) showLogin();
          var requestError = new Error(response.status === 401 ? t('sessionExpired') : (data.error || t('invalidExcel')));
          requestError.status = response.status;
          throw requestError;
        }
        return data;
      });
    }).then(function (result) {
      pendingImportFile = null;
      closeModal();
      toast(t('importDone'), tf('importSummary', result));
      return loadData(true);
    }).catch(function (error) {
      button.disabled = false;
      toast(t('actionFailed'), error.message || t('invalidExcel'), true);
    });
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
      alemiApiUrl: String(form.alemiApiUrl || '').trim(), alemiInstance: String(form.alemiInstance || '').trim(),
      alemiSecret: String(form.alemiSecret || ''),
      startNow: form.startNow !== false
    };
  }
  function openWizard(existing, options) {
    var step = 0;
    var cloneSourceId = String((options && options.cloneSourceId) || '');
    var data = existing ? {
      brand: existing.brand || '', address: existing.address || '', whatsappPhone: existing.whatsappPhone || '',
      workHours: existing.workHours || defaults.workHours, domain: existing.domain || '',
      systemPrompt: existing.systemPrompt || '', alemiApiUrl: existing.alemiApiUrl || 'https://hub.alemi.kz',
      alemiInstance: existing.alemiInstance || existing.instanceId || '', alemiSecret: '',
      alemiSecretSet: Boolean(existing.secrets && existing.secrets.alemiSecret), startNow: existing.startNow !== false
    } : { brand: '', address: '', whatsappPhone: '', workHours: defaults.workHours, domain: '', systemPrompt: '',
      alemiApiUrl: 'https://hub.alemi.kz', alemiInstance: '', alemiSecret: '', alemiSecretSet: false, startNow: true };
    var editingId = !cloneSourceId && existing && existing.instanceId;
    function draw() {
      var body = '';
      if (step === 0) body = '<div class="form-grid"><div class="field full"><label for="wizard-brand">' + t('restaurantName') +
        '</label><input id="wizard-brand" name="brand" value="' + attr(data.brand) + '" autofocus autocomplete="organization"><small>' + t('nameHint') +
        '</small></div><div class="field full"><label for="wizard-address">' + t('address') + ' <span class="optional">(' + t('optional') +
        ')</span></label><input id="wizard-address" name="address" value="' + attr(data.address) + '" autocomplete="street-address"></div></div>';
      if (step === 1) body = '<div class="form-grid"><div class="field full"><label for="wizard-phone">' + t('phone') + ' <span class="optional">(' + t('optional') +
        ')</span></label><input id="wizard-phone" name="whatsappPhone" value="' + attr(data.whatsappPhone) + '" inputmode="tel" placeholder="+7 700 000 00 00"><small>' + t('phoneHint') +
        '</small></div><div class="field"><label for="wizard-hours">' + t('hours') + ' <span class="optional">(' + t('optional') +
        ')</span></label><input id="wizard-hours" name="workHours" value="' + attr(data.workHours) + '" placeholder="09:00 - 23:00"><small>' + t('hoursHint') +
        '</small></div><div class="field"><label for="wizard-domain">' + t('domain') + ' <span class="optional">(' + t('optional') +
        ')</span></label><input id="wizard-domain" name="domain" value="' + attr(data.domain) + '" placeholder="' + attr((slugify(data.brand) || 'restaurant') + (defaults.domainSuffix ? '.' + defaults.domainSuffix : '.kz')) +
        '"><small>' + t('domainHint') + '</small></div></div>';
      if (step === 2) body = '<div class="form-grid"><div class="field"><label for="wizard-alemi-url">' + t('alemiApiUrl') +
        '</label><input id="wizard-alemi-url" name="alemiApiUrl" type="url" value="' + attr(data.alemiApiUrl) +
        '" inputmode="url" autocomplete="url"></div><div class="field"><label for="wizard-alemi-instance">' + t('alemiInstance') +
        '</label><input id="wizard-alemi-instance" name="alemiInstance" value="' + attr(data.alemiInstance) + '" autocomplete="off"></div>' +
        '<div class="field full"><label for="wizard-alemi-secret">' + t('alemiSecret') + '</label>' +
        '<div class="secret-row"><input id="wizard-alemi-secret" name="alemiSecret" type="password" value="' +
        attr(data.alemiSecret) + '" autocomplete="new-password">' + secretActions('wizard-alemi-secret') + '</div>' +
        '<small>' + (data.alemiSecretSet ? t('alemiSecretStored') + '. ' : '') + t('alemiSecretHint') +
        '</small></div><div class="field full"><label for="wizard-prompt">' + t('systemPrompt') + ' <span class="optional">(' + t('optional') +
        ')</span></label><textarea id="wizard-prompt" name="systemPrompt" placeholder="AI assistant…">' + escapeHtml(data.systemPrompt) +
        '</textarea><small>' + t('promptHint') + '</small></div></div>';
      if (step === 3) body = '<div class="review-grid">' +
        [['restaurantName', data.brand], ['instance', editingId || slugify(data.brand)], ['phone', data.whatsappPhone || '—'],
          ['hours', data.workHours || '—'], ['domain', data.domain || '—'], ['address', data.address || '—'],
          ['alemiApiUrl', data.alemiApiUrl], ['alemiInstance', data.alemiInstance],
          ['alemiSecret', data.alemiSecret ? t('alemiSecretWillUpdate') : (data.alemiSecretSet ? t('alemiSecretStored') : t('alemiSecretMissing'))],
          ['prompt', data.systemPrompt || t('sharedPrompt')]]
          .map(function (row) { return '<div class="review-row"><span>' + t(row[0]) + '</span><strong>' + escapeHtml(row[1]) + '</strong></div>'; }).join('') +
        '</div><label class="checkbox" for="wizard-start"><input id="wizard-start" type="checkbox" name="startNow" ' + (data.startNow ? 'checked' : '') + '><span>' + t('startImmediately') + '</span></label>';
      var footer = '<div class="modal-footer"><button class="button ghost" type="button" ' +
        (step ? 'data-wizard-back' : 'data-modal-close') + '>' + (step ? t('back') : t('cancel')) +
        '</button><span class="spacer"></span><button class="button primary" type="button" data-wizard-next>' +
          (step === 3 ? (editingId ? t('save') : (cloneSourceId ? t('duplicate') : t('createRestaurant'))) : t('continue')) + '</button></div>';
      replaceModal(modalHeader(editingId ? t('editRestaurant') : (cloneSourceId ? t('duplicateRestaurant') : t('newRestaurant')), t('fourSteps')) + wizardSteps(step) +
        '<div class="modal-body" data-wizard-body>' + body + '</div>' + footer);
    }
    function capture() {
      $$('input, textarea', modalRoot).forEach(function (input) {
        if (input.type === 'checkbox') data[input.name] = input.checked;
        else data[input.name] = input.value;
      });
      if (!data.alemiInstance && data.brand) data.alemiInstance = editingId || slugify(data.brand);
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
      if (step === 2 && !data.alemiSecret && !data.alemiSecretSet) {
        var secretInput = $('[name="alemiSecret"]', modalRoot);
        secretInput.closest('.field').classList.add('invalid');
        secretInput.focus();
        toast(t('requiredField'), t('alemiSecret'), true);
        return;
      }
      if (step < 3) { step += 1; draw(); return; }
      next.disabled = true;
      if (editingId) saveRestaurant(editingId, data);
      else createRestaurant(data, cloneSourceId);
    };
    draw();
  }
  function ensureInstance(instanceId, label) {
    return api('GET', '/api/wa/instances').then(function (data) {
      var found = normalizeInstances(data).some(function (item) { return String(item.instanceId || item.id) === instanceId; });
      return found ? { success: true } : api('POST', '/api/wa/instances', { instanceId: instanceId, label: label });
    });
  }
  function createRestaurant(data, cloneSourceId) {
    var generatedId = slugify(data.brand);
    var progress = 0;
    function drawProgress(error, done) {
      var steps = [t('savingRecord'), t('syncingInstance'), t('startingWhatsapp')];
      replaceModal(modalHeader(t('creating') + ' ' + data.brand, t('creatingCopy')) +
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
      systemPrompt: data.systemPrompt || '', alemiApiUrl: data.alemiApiUrl,
      alemiInstance: data.alemiInstance || generatedId, alemiSecret: data.alemiSecret || '', active: true
    };
    drawProgress();
    var createPath = cloneSourceId
      ? '/api/wa/tenants/' + encodeURIComponent(cloneSourceId) + '/clone'
      : '/api/wa/tenants';
    var createRequest = api('POST', createPath, payload);
    data.alemiSecret = '';
    payload.alemiSecret = '';
    createRequest.then(function (result) {
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
    var payload = {
      brand: data.brand, whatsappPhone: data.whatsappPhone || '', domain: data.domain || '',
      address: data.address || '', workHours: data.workHours || '', adminPhone: data.whatsappPhone || '',
      promptMode: data.systemPrompt ? 'custom' : 'shared', systemPrompt: data.systemPrompt || '',
      alemiApiUrl: data.alemiApiUrl, alemiInstance: data.alemiInstance || instanceId,
      alemiSecret: data.alemiSecret || '', active: true
    };
    var saveRequest = api('PATCH', '/api/wa/tenants/' + encodeURIComponent(instanceId), payload);
    data.alemiSecret = '';
    payload.alemiSecret = '';
    saveRequest.then(function () {
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
  function openDuplicate(instanceId) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant || tenant.virtual) return;
    var detail = settings.get(instanceId) || {};
    openWizard({
      brand: (tenant.brand || instanceId) + ' — ' + t('duplicateSuffix'),
      address: detail.address || '',
      whatsappPhone: '',
      workHours: detail.workHours || defaults.workHours,
      domain: '',
      systemPrompt: detail.systemPrompt || '',
      alemiApiUrl: detail.alemiApiUrl || 'https://hub.alemi.kz',
      alemiInstance: '', alemiSecret: '', alemiSecretSet: false,
      startNow: true
    }, { cloneSourceId: instanceId });
  }
  function openAlemiSecret(instanceId) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant || tenant.virtual) return;
    var detail = settings.get(instanceId) || {};
    openModal(modalHeader(t('rotateAlemiSecretTitle'), t('rotateAlemiSecretCopy')) +
      '<div class="modal-body"><div class="field"><label for="alemi-secret-input">' + t('alemiSecret') +
      '</label><div class="secret-row"><input id="alemi-secret-input" name="alemiSecret" type="password" autocomplete="new-password" autofocus>' +
      secretActions('alemi-secret-input') + '</div>' +
      '<small>' + (detail.secrets && detail.secrets.alemiSecret ? t('alemiSecretStored') + '. ' : '') + t('alemiSecretHint') +
      '</small></div></div><div class="modal-footer"><button class="button ghost" data-modal-close>' + t('cancel') +
      '</button><span class="spacer"></span><button class="button primary" data-save-alemi-secret data-instance="' + attr(instanceId) + '">' +
      t('save') + '</button></div>');
  }
  function openDelete(instanceId) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant || tenant.virtual) return;
    openModal(modalHeader(t('deleteTitle'), t('deleteCopy')) +
      '<div class="modal-body"><p class="confirm-copy">' + t('typeInstance') + '<span class="confirm-token"><strong>' + escapeHtml(instanceId) +
      '</strong><button class="copy-inline" type="button" data-copy-value="' + attr(instanceId) + '" aria-label="' + attr(t('copyInstance')) +
      '" title="' + attr(t('copyInstance')) + '">' + icon('copy') + '</button></span></p><div class="field"><label class="sr-only" for="delete-confirm-input">' +
      escapeHtml(t('instance')) + '</label><input id="delete-confirm-input" name="confirm" autocomplete="off" placeholder="' + attr(instanceId) +
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
  function toggleBot(instanceId, enabled) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant || tenant.virtual) return;
    closeModal();
    api('POST', '/api/wa/tenants/' + encodeURIComponent(instanceId) + '/bot-enabled', { enabled: enabled })
      .then(function () {
        tenant.botEnabled = enabled;
        if (settings.has(instanceId)) settings.get(instanceId).botEnabled = enabled;
        render();
        toast(t(enabled ? 'botResumed' : 'botPaused'), tenant.brand || instanceId);
      })
      .catch(function (error) { toast(t('actionFailed'), error.message, true); });
  }
  function toggleCalls(instanceId, disabled) {
    var tenant = report.tenants.find(function (item) { return item.instanceId === instanceId; });
    if (!tenant || tenant.virtual) return;
    closeModal();
    api('POST', '/api/wa/tenants/' + encodeURIComponent(instanceId) + '/calls-disabled', { disabled: disabled })
      .then(function () {
        tenant.callsDisabled = disabled;
        if (settings.has(instanceId)) settings.get(instanceId).callsDisabled = disabled;
        render();
        toast(t(disabled ? 'callsDisabledMsg' : 'callsEnabledMsg'), tenant.brand || instanceId);
      })
      .catch(function (error) { toast(t('actionFailed'), error.message, true); });
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
    var copy = event.target.closest('[data-copy-value]');
    if (copy) {
      copyText(copy.dataset.copyValue).catch(function (error) { toast(t('actionFailed'), error.message, true); });
      return;
    }
    var genSecret = event.target.closest('[data-generate-secret]');
    if (genSecret) {
      var genTarget = document.getElementById(genSecret.dataset.generateSecret);
      if (genTarget) {
        var fresh = generateNumericSecret(12);
        if (!fresh) { toast(t('actionFailed'), t('secretGenerateFailed'), true); return; }
        genTarget.type = 'text';
        genTarget.value = fresh;
        genTarget.dispatchEvent(new Event('input', { bubbles: true }));
        genTarget.focus();
        genTarget.select();
        toast(t('secretGenerated'), '');
      }
      return;
    }
    var copyInput = event.target.closest('[data-copy-input]');
    if (copyInput) {
      var copySource = document.getElementById(copyInput.dataset.copyInput);
      var copyValue = copySource ? String(copySource.value || '').trim() : '';
      if (!copyValue) { toast(t('actionFailed'), t('secretEmptyToCopy'), true); return; }
      copyText(copyValue, { title: t('secretCopied'), secret: true })
        .catch(function (error) { toast(t('actionFailed'), error.message, true); });
      return;
    }
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
      else if (name === 'alemi-secret') { closeModal(); window.setTimeout(function () { openAlemiSecret(instanceId); }, 0); }
      else if (name === 'duplicate') { closeModal(); window.setTimeout(function () { openDuplicate(instanceId); }, 0); }
      else if (name === 'export-excel') { closeModal(); exportWorkbook(instanceId); }
      else if (name === 'bot-toggle') toggleBot(instanceId, action.dataset.enabled === 'true');
      else if (name === 'calls-toggle') toggleCalls(instanceId, action.dataset.disabled === 'true');
      else if (name === 'restart' || name === 'reconnect') runInstanceAction(instanceId, name);
      else if (name === 'delete') { closeModal(); window.setTimeout(function () { openDelete(instanceId); }, 0); }
      else if (name === 'qr-refresh') {
        api('POST', '/api/wa/start', { instanceId: instanceId, label: tenant ? tenant.brand : instanceId })
          .then(function (live) { statuses.set(instanceId, live); refreshQrModal(instanceId); })
          .catch(function (error) { toast(t('actionFailed'), error.message, true); });
      } else if (name === 'qr-share') {
        shareQrLink(instanceId).catch(function (error) { toast(t('actionFailed'), error.message, true); });
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
    var saveAlemiSecret = event.target.closest('[data-save-alemi-secret]');
    if (saveAlemiSecret) {
      var secretId = saveAlemiSecret.dataset.instance;
      var inlineSecretId = saveAlemiSecret.dataset.secretInput;
      var alemiSecretInput = inlineSecretId
        ? document.getElementById(inlineSecretId)
        : $('[name="alemiSecret"]', modalRoot);
      var secretValue = alemiSecretInput ? alemiSecretInput.value : '';
      if (!secretValue.trim()) {
        if (alemiSecretInput) {
          var invalidHost = alemiSecretInput.closest('.field') || alemiSecretInput.closest('.secret-item');
          if (invalidHost) invalidHost.classList.add('invalid');
          alemiSecretInput.focus();
        }
        toast(t('requiredField'), t('alemiSecret'), true);
        return;
      }
      saveAlemiSecret.disabled = true;
      var secretRequest = api('POST', '/api/wa/tenants/' + encodeURIComponent(secretId) + '/alemi-secret', { secret: secretValue });
      if (alemiSecretInput) alemiSecretInput.value = '';
      secretValue = '';
      secretRequest.then(function () {
        if (!inlineSecretId) closeModal();
        toast(t('secretUpdated'), secretId);
        return loadData(true);
      }).catch(function (error) {
        saveAlemiSecret.disabled = false;
        toast(t('actionFailed'), error.message, true);
      });
      return;
    }
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
    var importConfirm = event.target.closest('[data-import-confirm]');
    if (importConfirm && pendingImportFile) {
      importWorkbook(pendingImportFile, importConfirm);
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
      else { openMenuId = ''; $('#profile-menu').hidden = true; closeMobileNav(); render(); }
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
  var searchRenderFrame = 0;
  searchEl.addEventListener('input', function (event) {
    searchQuery = event.target.value;
    window.cancelAnimationFrame(searchRenderFrame);
    searchRenderFrame = window.requestAnimationFrame(render);
  });
  $('#focus-mode').addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
  $('#locale-button').addEventListener('click', function (event) {
    event.stopPropagation();
    locale = locale === 'kk' ? 'ru' : 'kk';
    localStorage.setItem('whatspro_locale', locale);
    $('#locale-button').setAttribute('aria-expanded', 'false');
    $('#profile-menu').hidden = true;
    applyStaticTranslations();
    render();
  });
  $('#profile-button').addEventListener('click', function (event) {
    event.stopPropagation();
    var menu = $('#profile-menu');
    menu.hidden = !menu.hidden;
    $('#profile-button').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest('.profile-wrap')) { $('#profile-menu').hidden = true; $('#profile-button').setAttribute('aria-expanded', 'false'); }
  });
  $('#profile-menu').addEventListener('click', function (event) {
    var action = event.target.closest('[data-profile-action]');
    if (!action) return;
    if (action.dataset.profileAction === 'refresh') loadData();
    if (action.dataset.profileAction === 'export') exportWorkbook('');
    if (action.dataset.profileAction === 'import') $('#tenant-import-input').click();
    if (action.dataset.profileAction === 'logout') {
      api('POST', '/api/platform/logout', {}).then(function () { authUsername = ''; showLogin(); })
        .catch(function (error) { toast(t('signOutFailed'), error.message, true); });
    }
  });
  $('#tenant-import-input').addEventListener('change', function (event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file || !/\.xlsx$/i.test(file.name) || file.size > 8 * 1024 * 1024) {
      if (file) toast(t('actionFailed'), t('invalidExcel'), true);
      return;
    }
    $('#profile-menu').hidden = true;
    openImportModal(file);
  });
  $('#refresh-button').addEventListener('click', function () { loadData(); });
  $('#sidebar-toggle').addEventListener('click', function () { appShell.classList.toggle('collapsed'); });
  $('#mobile-menu').addEventListener('click', function () {
    appShell.classList.add('mobile-nav-open');
    $('#mobile-scrim').hidden = false;
  });
  $('#mobile-scrim').addEventListener('click', closeMobileNav);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) syncLiveStatuses(); });

  function syncLoginInputState(input) {
    var wrapper = input.closest('.input-with-icon');
    if (wrapper) wrapper.classList.toggle('has-value', Boolean(input.value));
  }
  ['login-username', 'login-password'].forEach(function (id) {
    var input = $('#' + id);
    input.addEventListener('input', function () { syncLoginInputState(input); });
    input.addEventListener('change', function () { syncLoginInputState(input); });
  });

  loginForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var username = $('#login-username').value.trim();
    var password = $('#login-password').value;
    var remember = $('#login-remember').checked;
    if (!username || !password) {
      setLoginError(t('loginRequired'));
      (!username ? $('#login-username') : $('#login-password')).focus();
      return;
    }
    setLoginError('');
    var submit = $('#login-submit');
    submit.disabled = true;
    $('#login-submit-label').textContent = t('signingIn');
    api('POST', '/api/platform/login', { username: username, password: password, remember: remember })
      .then(function (result) {
        if (remember) {
          localStorage.setItem('platform_remember_login', '1');
          localStorage.setItem('platform_login_username', username);
          localStorage.removeItem('whatspro_remember_login');
          localStorage.removeItem('whatspro_login_username');
        } else {
          localStorage.removeItem('platform_remember_login');
          localStorage.removeItem('platform_login_username');
          localStorage.removeItem('whatspro_remember_login');
          localStorage.removeItem('whatspro_login_username');
        }
        $('#login-password').value = '';
        syncLoginInputState($('#login-password'));
        return startApp(result.username || username);
      })
      .catch(function (error) {
        var message = error.code === 'LOGIN_NOT_CONFIGURED' ? t('loginNotConfigured')
          : (error.code === 'INVALID_CREDENTIALS' ? t('invalidCredentials') : error.message);
        setLoginError(message);
        $('#login-password').select();
      })
      .finally(function () {
        submit.disabled = false;
        $('#login-submit-label').textContent = t('signIn');
      });
  });

  applyStaticTranslations();
  checkSession();
  window.setInterval(updateChrome, 10000);
}());
