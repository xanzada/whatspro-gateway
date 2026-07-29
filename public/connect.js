(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var locale = params.get('lang') === 'ru' ? 'ru' : 'kk';
  var timer = 0;
  var stopped = false;
  var text = {
    kk: {
      code: 'ҚАЗ', title: 'WhatsApp-ты қосыңыз', eyebrow: 'ҚАУІПСІЗ ҚОСЫЛУ',
      description: 'WhatsApp → Байланыстырылған құрылғылар → Құрылғыны байланыстыру бөлімін ашып, QR кодты сканерлеңіз.',
      preparing: 'QR дайындалуда…', starting: 'Сессия іске қосылуда', wait: 'Бұл бетті жаппай тұрыңыз.',
      ready: 'QR дайын', scan: 'Кодты WhatsApp арқылы сканерлеңіз.', connected: 'WhatsApp сәтті қосылды',
      connectedCopy: 'Сессия сақталды. Бұл бетті жабуға болады.', invalid: 'Сілтеме жарамсыз немесе мерзімі аяқталған',
      invalidCopy: 'Жаңа қосылу сілтемесін әкімшіден сұраңыз.', retry: 'Қайта тексеру',
      security: 'Сілтеме бір нысанға ғана арналған және автоматты түрде жарамсыз болады.'
    },
    ru: {
      code: 'РУС', title: 'Подключите WhatsApp', eyebrow: 'БЕЗОПАСНОЕ ПОДКЛЮЧЕНИЕ',
      description: 'Откройте WhatsApp → Связанные устройства → Привязка устройства и отсканируйте QR-код.',
      preparing: 'QR подготавливается…', starting: 'Сессия запускается', wait: 'Не закрывайте эту страницу.',
      ready: 'QR готов', scan: 'Отсканируйте код через WhatsApp.', connected: 'WhatsApp успешно подключён',
      connectedCopy: 'Сессия сохранена. Эту страницу можно закрыть.', invalid: 'Ссылка недействительна или истекла',
      invalidCopy: 'Попросите у администратора новую ссылку подключения.', retry: 'Проверить снова',
      security: 'Ссылка предназначена только для одной точки и автоматически станет недействительной.'
    }
  };
  function $(id) { return document.getElementById(id); }
  function t(key) { return text[locale][key]; }
  function applyLocale() {
    document.documentElement.lang = locale;
    document.title = 'WhatsPro — ' + t('title');
    $('locale-button').textContent = t('code');
    $('connect-title').textContent = t('title');
    $('eyebrow').textContent = t('eyebrow');
    $('connect-description').textContent = t('description');
    $('retry-button').textContent = t('retry');
    $('security-copy').textContent = t('security');
  }
  function setStatus(kind, title, copy) {
    $('status').className = 'status ' + (kind || '');
    $('status-title').textContent = title;
    $('status-copy').textContent = copy;
  }
  function showError() {
    stopped = true;
    window.clearTimeout(timer);
    $('qr-frame').innerHTML = '<span id="qr-placeholder"></span>';
    $('qr-placeholder').textContent = t('invalid');
    setStatus('error', t('invalid'), t('invalidCopy'));
    $('retry-button').hidden = false;
  }
  async function poll() {
    if (stopped || !token) return showError();
    try {
      var response = await fetch('/api/wa/connect/' + encodeURIComponent(token) + '/status', {
        headers: { accept: 'application/json' },
        cache: 'no-store'
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 401 || response.status === 404) return showError();
        throw new Error(data.error || 'STATUS_UNAVAILABLE');
      }
      $('brand-name').textContent = data.brand || 'WhatsApp';
      $('retry-button').hidden = true;
      if (data.status === 'connected') {
        stopped = true;
        $('qr-frame').innerHTML = '<span aria-hidden="true" style="font-size:56px;color:#159c7c">✓</span>';
        setStatus('connected', t('connected'), t('connectedCopy'));
        return;
      }
      if (data.qr) {
        var image = new Image();
        image.alt = 'WhatsApp QR';
        image.src = data.qr;
        $('qr-frame').replaceChildren(image);
        setStatus('', t('ready'), t('scan'));
      } else {
        setStatus('', t('starting'), t('wait'));
      }
      timer = window.setTimeout(poll, 1900);
    } catch {
      setStatus('error', t('starting'), t('wait'));
      $('retry-button').hidden = false;
      timer = window.setTimeout(poll, 4000);
    }
  }
  $('locale-button').addEventListener('click', function () {
    locale = locale === 'kk' ? 'ru' : 'kk';
    applyLocale();
  });
  $('retry-button').addEventListener('click', function () {
    stopped = false;
    $('retry-button').hidden = true;
    poll();
  });
  applyLocale();
  $('qr-placeholder').textContent = t('preparing');
  poll();
}());
