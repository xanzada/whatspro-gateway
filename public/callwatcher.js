(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var instanceId = String(new URLSearchParams(location.search).get('instance') || '').trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(instanceId)) {
    $('cw-instance').textContent = '—';
    show('Ресторан instance көрсетілмеген. /tenants бетінен қайта ашыңыз.');
    return;
  }
  $('cw-instance').textContent = instanceId;

  var lastQr = null;

  function show(message) {
    $('cw-frame').replaceChildren(Object.assign(document.createElement('span'), {
      id: 'cw-status', textContent: message
    }));
  }

  function showDone() {
    var mark = document.createElement('span');
    mark.setAttribute('aria-hidden', 'true');
    mark.style.cssText = 'font-size:56px;color:#159c7c';
    mark.textContent = '✓';
    var text = document.createElement('p');
    text.textContent = 'Байланысты. Бот енді қоңырауды көреді.';
    $('cw-frame').replaceChildren(mark);
    $('cw-frame').appendChild(text);
  }

  // The socket, not this page, decides when onboarding is finished, so the poll
  // keeps running until the API reports connected.
  async function poll() {
    try {
      var response = await fetch('/api/wa/tenants/' + encodeURIComponent(instanceId) + '/call-watcher', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (response.status === 401) return show('Кіру қажет: әуелі /tenants бетіне кіріңіз.');
      var data = await response.json();

      if (data.connected) {
        showDone();
        return;
      }
      // An unlink invalidates whatever code is on screen, and the gateway is
      // already asking for a new one, so the old image must not stay up.
      if (data.loggedOut) {
        lastQr = null;
        show('Телефон құрылғыны ажыратты. Жаңа QR дайындалуда…');
      } else if (data.qr && data.qr !== lastQr) {
        lastQr = data.qr;
        var image = new Image();
        image.alt = 'QR';
        image.src = data.qr;
        $('cw-frame').replaceChildren(image);
      } else if (!data.qr && !lastQr) {
        if (!data.watching) show('Бақылаушы іске қосылмаған.');
        else show(data.awaitingScan ? 'QR сканерлеуді күтіп тұр…' : 'QR дайындалуда…');
      }
    } catch (error) {
      show('Байланыс үзілді, қайта қосылуда…');
    }
    setTimeout(poll, 3000);
  }

  poll();
})();
