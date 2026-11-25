// Embeddable converter for firm websites:
//   <div id="statementotter"></div>
//   <script src="https://statementotter.com/embed.js" data-key="emb_..." async></script>
(function () {
  var s = document.currentScript || document.querySelector('script[data-key][src*="embed.js"]');
  if (!s) return;
  var key = s.getAttribute('data-key');
  var origin = new URL(s.src).origin;
  var host = document.getElementById(s.getAttribute('data-target') || 'statementotter');
  if (!host) { host = document.createElement('div'); s.parentNode.insertBefore(host, s); }
  var f = document.createElement('iframe');
  f.src = origin + '/embed/?k=' + encodeURIComponent(key);
  f.title = 'Bank statement converter';
  f.style.cssText = 'width:100%;border:0;min-height:520px';
  host.appendChild(f);
  window.addEventListener('message', function (e) {
    if (e.origin === origin && e.source === f.contentWindow && e.data && e.data.statementotterHeight) {
      f.style.height = Math.min(4000, Number(e.data.statementotterHeight) || 520) + 'px';
    }
  });
})();
