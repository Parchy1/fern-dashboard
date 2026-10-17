/* Bottom tab bar shared by all 4 pages. */
(function () {
  if (window.self !== window.top) return; // water tracker is iframed in Body
  var tabs = [
    ['index.html', 'Today', '✅'],
    ['gym.html', 'Gym', '💪'],
    ['health.html', 'Body', '💊'],
    ['money.html', 'Money', '💵']
  ];
  var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var css = document.createElement('style');
  css.textContent =
    '.fnav{position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;justify-content:space-around;' +
    'padding:8px 6px calc(8px + env(safe-area-inset-bottom));background:rgba(10,10,12,.92);' +
    'backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-top:1px solid rgba(255,255,255,.08);' +
    'font:600 11px -apple-system,BlinkMacSystemFont,Inter,sans-serif}' +
    '.fnav a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;color:#8a8880;text-decoration:none;padding:4px 0}' +
    '.fnav a.on{color:#fafafa}.fnav span{font-size:20px;line-height:1}' +
    'body{padding-bottom:calc(76px + env(safe-area-inset-bottom))!important}';
  document.head.appendChild(css);
  var nav = document.createElement('nav');
  nav.className = 'fnav';
  nav.setAttribute('aria-label', 'Tabs');
  nav.innerHTML = tabs.map(function (t) {
    var on = here === t[0] || (here === '' && t[0] === 'index.html');
    return '<a href="' + t[0] + '"' + (on ? ' class="on" aria-current="page"' : '') + '><span>' + t[2] + '</span>' + t[1] + '</a>';
  }).join('');
  document.body.appendChild(nav);
})();
